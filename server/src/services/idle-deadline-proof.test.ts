import { pluginIdleManifestGeneration } from "./plugin-idle-catalog.js";
import { agents, heartbeatRuns, costEvents, issues, type Db } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";
import { readIdleAgentTimerSchedule } from "./heartbeat/idle-timer-schedule.js";
import { createHeartbeatTimerPolicy } from "./heartbeat/timer-policy.js";
import { describe, expect, it } from "vitest";
import { composeIdleDeadlineProof, createIdleDeadlineInspectionBudget, deadlineWorkReplacement, readIdleDeadlineProof,
  IdleDeadlineInspectionBudgetExceeded, type IdleDeadlineProofOptions } from "./idle-deadline-proof.js";
import type { VerifiedIdleCapabilities } from "./idle-incoming-wake-capability.js";
import { projectIdlePluginJobSchedule, type IdlePluginJobRow } from "./plugin-job-idle-schedule.js";
import { projectIdleProviderTraceSchedule, type IdleProviderTraceRow } from "./provider-trace-idle-schedule.js";
import { projectIdleGitHubGrantContinuity } from "./tool-access/github-grant-continuity.js";

const now = Date.parse("2099-01-01T00:00:00Z");
const verifiedCapability = { deadlineCatalog: "domain_deadlines_v1" } as VerifiedIdleCapabilities;
const options: IdleDeadlineProofOptions = { now, verifiedCapability, quietPluginIds: [] };
const hold = { ownerId: "owned", expiresAt: now + 300_000 };
const snapshot = (state: unknown = [], deadlines: number[] = []) => ({ blocked: false, state, deadlines });
const fixtures = () => ({ timers: snapshot(["agent"], [now + 600_000]), jobs: snapshot(), traces: snapshot(),
  github: { ...snapshot(), connectionIds: [] as string[] } });

describe("domain deadline handoff", () => {
  it("preserves earliest legacy and owner obligations without moving an inspected deadline", () => {
    const all = fixtures(); all.traces = snapshot(["trace"], [now + 500_000]);
    const routine = { version: 1 as const, kind: "routines_and_issue_monitors" as const,
      generation: "b".repeat(64), nextWakeAt: new Date(now + 400_000).toISOString() };
    const first = composeIdleDeadlineProof(hold, { ...options, scheduledWake: routine }, all);
    expect(first.scheduledWake).toMatchObject({ version: 2, kind: "domain_deadlines", catalog: "domain_deadlines_v1", nextWakeAt: routine.nextWakeAt });
    expect(composeIdleDeadlineProof(hold, { ...options, now: now + 1, scheduledWake: routine }, all)).toEqual(first);
  });
  it("binds passive state, drain owner/expiry and exact plugin worker generation", () => {
    const all = fixtures(), first = composeIdleDeadlineProof(hold, options, all);
    const passive = fixtures(); passive.jobs.state = ["changed-paused-job"];
    expect(composeIdleDeadlineProof(hold, options, passive).generation).not.toBe(first.generation);
    expect(composeIdleDeadlineProof({ ...hold, ownerId: "replacement" }, options, all).generation).not.toBe(first.generation);
    expect(composeIdleDeadlineProof({ ...hold, expiresAt: hold.expiresAt + 1 }, options, all).generation).not.toBe(first.generation);
    const plugin = { ...options, quietPluginIds: ["plugin"], quietPluginGeneration: "worker-1" };
    expect(composeIdleDeadlineProof(hold, plugin, all).generation).not.toBe(composeIdleDeadlineProof(hold, { ...plugin, quietPluginGeneration: "worker-2" }, all).generation);
  });
  it("invalidates moved-earlier/cancelled obligations and refuses due/unknown work", () => {
    const all = fixtures(), first = composeIdleDeadlineProof(hold, options, all);
    all.timers = snapshot(["edited"], [now + 450_000]);
    expect(composeIdleDeadlineProof(hold, options, all).generation).not.toBe(first.generation);
    all.timers = snapshot(["cancelled"]);
    expect(composeIdleDeadlineProof(hold, options, all).scheduledWake).toBeUndefined();
    all.timers = snapshot(["due"], [now]);
    expect(composeIdleDeadlineProof(hold, options, all)).toEqual({ blocked: true });
    expect(composeIdleDeadlineProof(hold, { ...options, verifiedCapability: undefined }, fixtures())).toEqual({ blocked: true });
    expect(composeIdleDeadlineProof(hold, { ...options, quietPluginIds: ["missing-worker"] }, fixtures())).toEqual({ blocked: true });
  });
  it("keeps watchdogs, pending merge cards, and recovery predicates intact", () => {
    expect(deadlineWorkReplacement("agents.execution_or_timer")).toBe("SELECT 1 FROM agents WHERE status = 'running'");
    expect(deadlineWorkReplacement("plugin_jobs")).toContain("NOT IN ('active', 'paused')");
    for (const reason of ["issue_watchdogs", "issue_thread_interactions", "heartbeat_runs", "unknown"]) expect(deadlineWorkReplacement(reason)).toBeUndefined();
  });
  it("bounds whole-inspection query count and monotonic elapsed time before final hold headroom", () => {
    let elapsed = 0;
    const budget = createIdleDeadlineInspectionBudget(now, hold.expiresAt, () => elapsed);
    for (let i = 0; i < 64; i++) budget.beforeQuery();
    expect(budget.queries).toBe(64);
    expect(() => budget.beforeQuery()).toThrow(IdleDeadlineInspectionBudgetExceeded);
    const timed = createIdleDeadlineInspectionBudget(now, hold.expiresAt, () => elapsed);
    elapsed = 2_000;
    expect(() => timed.beforeQuery()).toThrow(IdleDeadlineInspectionBudgetExceeded);
    const short = createIdleDeadlineInspectionBudget(now, now + 60_000, () => 0);
    expect(() => short.beforeQuery()).toThrow(IdleDeadlineInspectionBudgetExceeded);
    expect(short.queries).toBe(0);
  });
});

const pluginJob = (): IdlePluginJobRow => ({ job: { id: "job", pluginId: "plugin", jobKey: "daily", status: "active", schedule: "0 * * * *", nextRunAt: new Date(now + 600_000) } as IdlePluginJobRow["job"], plugin: { id: "plugin", pluginKey: "fixture", version: "1.0.0", apiVersion: 1, status: "ready", manifestJson: { id: "fixture", version: "1.0.0", apiVersion: 1, jobs: [{ jobKey: "daily", schedule: "0 * * * *" }] } } as IdlePluginJobRow["plugin"], unsettled: false });
it("plugin jobs require exact quiet catalog/declaration and retain unsettled/missing/due work", () => {
  const row = pluginJob();
  const catalog = [{ pluginId: "plugin", manifestGeneration: pluginIdleManifestGeneration(row.plugin!.manifestJson) }];
  expect(projectIdlePluginJobSchedule([row], ["plugin"], now, catalog).deadlines).toEqual([now + 600_000]);
  expect(projectIdlePluginJobSchedule([row], [], now).blocked).toBe(true);
  for (const edit of [{ unsettled: true }, { job: { ...row.job, nextRunAt: null } }, { job: { ...row.job, nextRunAt: new Date(now) } }])
    expect(projectIdlePluginJobSchedule([{ ...row, ...edit }], ["plugin"], now, catalog).blocked).toBe(true);
  row.plugin!.manifestJson.jobs![0].schedule = "*/5 * * * *";
  expect(projectIdlePluginJobSchedule([row], ["plugin"], now, catalog).blocked).toBe(true);
  row.job.status = "paused";
  expect(projectIdlePluginJobSchedule([row], [], now)).toMatchObject({ blocked: false, deadlines: [] });
});
const trace = (): IdleProviderTraceRow => ({ finishedRun: true, trace: { id: "trace", companyId: "company", runId: "run", status: "complete", traceRef: "s3-segments-v1:company/run/11111111-1111-4111-8111-111111111111.ndjson", expiresAt: new Date(now + 86_400_000), deletedAt: null } as IdleProviderTraceRow["trace"] });
it("trace expiry transfers actual retained data; capture/import/deletion/cross-company work stays blocked", () => {
  const row = trace(), original = JSON.stringify(row);
  expect(projectIdleProviderTraceSchedule([row], now)).toMatchObject({ blocked: false, deadlines: [now + 86_400_000] });
  expect(JSON.stringify(row)).toBe(original);
  for (const patch of [{ status: "capturing" }, { traceRef: row.trace.traceRef.replace("s3-segments-v1:", "s3-import-v1:") }, { companyId: "foreign" }, { expiresAt: new Date(now) }, { status: "deleted", deletedAt: new Date(now) }])
    expect(projectIdleProviderTraceSchedule([{ ...trace(), trace: { ...trace().trace, ...patch } }], now).blocked).toBe(true);
  expect(projectIdleProviderTraceSchedule([{ ...trace(), finishedRun: false }], now).blocked).toBe(true);
  const expired = trace(); expired.trace.status = "expired"; expired.trace.deletedAt = new Date(now); expired.trace.traceRef = "00000000-0000-0000-0000-000000000000.ndjson";
  expect(projectIdleProviderTraceSchedule([expired], now)).toMatchObject({ blocked: false, deadlines: [] });
});
type ContinuityRow = Parameters<typeof projectIdleGitHubGrantContinuity>[0][number];
const github = (): ContinuityRow => ({ companyStatus: "active", connection: { id: "connection", companyId: "company", status: "active", enabled: true, authKind: "oauth", credentialSource: "paperclip_vault", config: { sourceTemplateKey: "github", oauth: { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" } } } as unknown as ContinuityRow["connection"], grant: { id: "grant", companyId: "company", connectionId: "connection", kind: "user", subjectUserId: "user", credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: "secret" }], providerTenant: { oauth: { accessTokenExpiresAt: new Date(now + 8 * 3_600_000).toISOString(), refreshedAt: new Date(now).toISOString() }, github: { userId: "user", installationIds: ["101"], lastAccessRefreshAt: new Date(now).toISOString() } } } as ContinuityRow["grant"] });
it("GitHub enrollment alone never bypasses its credential continuity deadline or unresolved authority", () => {
  expect(projectIdleGitHubGrantContinuity([github()], now)).toMatchObject({ blocked: false, deadlines: [now + 7 * 3_600_000], connectionIds: ["connection"] });
  const nonexpiring = github(); delete nonexpiring.grant.providerTenant!.oauth;
  expect(projectIdleGitHubGrantContinuity([nonexpiring], now).deadlines).toEqual([now + 30 * 86_400_000]);
  const missing = github(); missing.grant.credentialSecretRefs = [];
  expect(projectIdleGitHubGrantContinuity([missing], now).blocked).toBe(true);
  const foreign = github(); foreign.grant.companyId = "foreign";
  expect(projectIdleGitHubGrantContinuity([foreign], now).blocked).toBe(true);
  const expired = github(); expired.grant.providerTenant!.oauth!.accessTokenExpiresAt = new Date(now).toISOString();
  expect(projectIdleGitHubGrantContinuity([expired], now).blocked).toBe(true);
});


function timerAgent(index: number): typeof agents.$inferSelect {
  return { id: `agent-${index}`, companyId: "company", name: "Timer", status: "idle", reportsTo: null,
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, maxDailyRuns: 1 } },
    createdAt: new Date(now), lastHeartbeatAt: new Date(now) } as unknown as typeof agents.$inferSelect;
}
function fixtureDb(tables: Record<string, unknown[]>, onRead: () => void = () => {}) {
  return { select: () => {
    onRead();
    let table = "";
    const query = { from: (source: Parameters<typeof getTableName>[0]) => { table = getTableName(source); return query; },
      leftJoin: () => query, orderBy: () => query, where: () => query, groupBy: () => query,
      limit: () => Promise.resolve(tables[table] ?? []),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(tables[table] ?? []).then(resolve) };
    return query;
  } } as unknown as Pick<Db, "select">;
}
it("batches more than128 eligible timers and the old80 run-cap shape within a fixed query budget", async () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({ agent: timerAgent(i), companyStatus: "active", companyUpdatedAt: new Date(now) }));
  rows.push(...["paused", "terminated", "idle"].map((status, i) => ({ agent: { ...timerAgent(200 + i), status,
    runtimeConfig: { heartbeat: { enabled: false } } }, companyStatus: "active", companyUpdatedAt: new Date(now) })));
  let reads = 0;
  const tables: Record<string, unknown[]> = { agents: rows };
  const tx = fixtureDb(tables, () => { reads++; });
  const future = await readIdleDeadlineProof(tx, hold, options);
  expect(future.blocked).toBe(false);
  expect(future.scheduledWake?.nextWakeAt).toBe(new Date(now + 3_600_000).toISOString());
  expect(reads).toBe(5);
  tables.agents = rows.slice(0, 80); reads = 0;
  expect((await readIdleDeadlineProof(tx, hold, options)).blocked).toBe(false);
  expect(reads).toBe(5);
  rows[0].agent.lastHeartbeatAt = new Date(now - 3_600_000); tables.agents = rows; reads = 0;
  expect((await readIdleDeadlineProof(tx, hold, options)).blocked).toBe(true);
  expect(reads).toBe(2);
  rows[0].agent.lastHeartbeatAt = new Date(now);
  tables.agents = Array.from({ length: 10_001 }, () => rows[0]); reads = 0;
  expect(await readIdleDeadlineProof(tx, hold, options)).toEqual({ blocked: true });
  expect(reads).toBe(1);
  tables.agents = rows;
  for (const total of [null, "", true, false, "0", NaN, Infinity, -1, 1.5]) {
    tables.heartbeat_runs = [{ companyId: rows[0].agent.companyId, agentId: rows[0].agent.id, total }];
    expect((await readIdleDeadlineProof(tx, hold, options)).blocked).toBe(true);
  }
  tables.heartbeat_runs = [{ companyId: "foreign", agentId: rows[0].agent.id, total: 0 }];
  expect((await readIdleDeadlineProof(tx, hold, options)).blocked).toBe(true);
});
it("single and batch owner schedules share cap, actionable, UTC and decimal semantics", async () => {
  for (const heartbeat of [
    { enabled: false }, { enabled: true, intervalSec: 600, maxDailyRuns: 0 },
    { enabled: true, intervalSec: 600, maxDailyRuns: 2 },
    { enabled: true, intervalSec: 600, maxDailyCostCents: 1 },
    { enabled: true, intervalSec: 600, maxDailyRuns: 2, maxDailyCostCents: 1, skipTimerWhenNoActionableWork: true },
  ]) for (const actionable of [false, true]) for (const runTotal of [0, 2]) for (const cost of ["0.999999", "1.000001"]) {
    const agent = { ...timerAgent(0), runtimeConfig: { heartbeat } };
    const owner = createHeartbeatTimerPolicy(fixtureDb({
      [getTableName(heartbeatRuns)]: [{ companyId: agent.companyId, agentId: agent.id, total: runTotal }],
      [getTableName(costEvents)]: [{ companyId: agent.companyId, agentId: agent.id, total: cost }],
      [getTableName(issues)]: actionable ? [{ companyId: agent.companyId, agentId: agent.id, id: "issue" }] : [],
    }));
    const single = await owner.readTimerHeartbeatSchedule(agent, new Date(now));
    const batch = await owner.readTimerHeartbeatSchedules([agent], new Date(now));
    expect(batch?.schedules.get(agent.id)).toEqual(single);
  }
});
it("checks global suppression even without eligible timers and retains owner org-chain checks", async () => {
  for (const rows of [[], [timerAgent(1)], [{ ...timerAgent(1), status: "paused" }]]) {
    if (rows[0]?.status === "idle") rows[0].runtimeConfig = { heartbeat: { enabled: false } };
    for (const env of [{ PAPERCLIP_IN_WORKTREE: "true" }, { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" },
      { PAPERCLIP_RESTORE_IN_PROGRESS: "yes" }, { HEARTBEAT_SCHEDULER_ENABLED: "false" }]) {
      let reads = 0;
      expect((await readIdleAgentTimerSchedule(fixtureDb({ agents: rows }, () => { reads++; }), now, env)).blocked).toBe(true);
      expect(reads).toBe(0);
    }
  }
  const parent = timerAgent(1), child = { ...timerAgent(2), reportsTo: parent.id };
  const rows = [parent, child].map(agent => ({ agent, companyStatus: "active", companyUpdatedAt: new Date(now) }));
  const tx = fixtureDb({ agents: rows });
  expect((await readIdleAgentTimerSchedule(tx, now, {})).blocked).toBe(false);
  parent.status = "paused";
  expect((await readIdleAgentTimerSchedule(tx, now, {})).blocked).toBe(false);
  parent.status = "terminated";
  expect((await readIdleAgentTimerSchedule(tx, now, {})).blocked).toBe(true);
  parent.status = "idle"; parent.reportsTo = child.id;
  expect((await readIdleAgentTimerSchedule(tx, now, {})).blocked).toBe(true);
  let checks = 0;
  await expect(readIdleAgentTimerSchedule(tx, now, {}, () => {
    if (++checks > 1) throw new IdleDeadlineInspectionBudgetExceeded();
  })).rejects.toThrow(IdleDeadlineInspectionBudgetExceeded);
});
it("does not turn unrelated GitHub grant shapes into continuity authority", () => {
  const unrelated = github(); unrelated.connection!.authKind = "api_key";
  expect(projectIdleGitHubGrantContinuity([unrelated], now)).toMatchObject({ blocked: false, deadlines: [], connectionIds: [] });
  unrelated.connection!.authKind = "oauth"; unrelated.connection!.config = { sourceTemplateKey: "other" };
  expect(projectIdleGitHubGrantContinuity([unrelated], now)).toMatchObject({ blocked: false, connectionIds: [] });
  for (const patch of [{ oauth: { connectorProfile: "github.code", strategy: "unknown_strategy" } },
    { oauth: { connectorProfile: "github.code" } }, { oauth: null }, { oauth: { connectorProfile: 123 } }]) {
    const malformed = github(); malformed.connection!.config = { sourceTemplateKey: "github", ...patch };
    expect(projectIdleGitHubGrantContinuity([malformed], now).blocked).toBe(true);
  }
  for (const patch of [{ authKind: "unknown_auth" }, { credentialSource: "unknown_source" }]) {
    const malformed = github(); Object.assign(malformed.connection!, patch);
    expect(projectIdleGitHubGrantContinuity([malformed], now).blocked).toBe(true);
  }
  const persisted = github(); persisted.connection!.config.oauth = { connectorProfile: "github.code", strategy: "paperclip_id_connector" };
  expect(projectIdleGitHubGrantContinuity([persisted], now).blocked).toBe(false);
  const agent = github(); agent.grant.kind = "agent"; agent.grant.subjectUserId = null; agent.grant.subjectAgentId = "dedicated-agent";
  expect(projectIdleGitHubGrantContinuity([agent], now).connectionIds).toEqual(["connection"]);
  const orphan = github(); orphan.connection = null;
  expect(projectIdleGitHubGrantContinuity([orphan], now).blocked).toBe(true);
});
