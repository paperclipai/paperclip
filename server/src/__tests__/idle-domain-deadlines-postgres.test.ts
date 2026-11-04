import { createGitHubGrantContinuity, readIdleGitHubGrantContinuity } from "../services/tool-access/github-grant-continuity.js";
import { createOAuthCredentialStore } from "../services/tool-access/oauth/credential-store.js";
import { createOAuthRefreshLeases } from "../services/tool-access/oauth/refresh-leases.js";
import { createOAuthGrantRefresh } from "../services/tool-access/oauth/grant-refresh.js";
import { secretService } from "../services/secrets.js";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { GITHUB_CONNECTOR_PROFILES } from "@paperclipai/shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { startTaskDrain, stopTaskDrain, beginIdleTrackedWork } from "../services/task-admission.js";
import { providerTraceStore } from "../services/provider-trace-store.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { randomUUID } from "node:crypto";
import { eq, sql, inArray } from "drizzle-orm";
import { agents, companies, heartbeatRuns, plugins, pluginJobs, pluginJobRuns, pluginState, providerTraceRecords, issues, issueWatchdogs, issueThreadInteractions, toolApplications, toolConnections, connectionGrants, companySecrets, companySecretVersions, routines, routineTriggers,
  applyPendingMigrations, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { readIdleDeadlineProof } from "../services/idle-deadline-proof.js";
import type { VerifiedIdleCapabilities } from "../services/idle-incoming-wake-capability.js";
import { claimDueTimerHeartbeatForAgent } from "../services/heartbeat/queue.js";
import { pluginJobStore } from "../services/plugin-job-store.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_IDLE_DEADLINE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable domain deadline snapshot with PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("idle-domain-deadlines-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "idle-deadline-producers-"));
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(directory, "config.json"));
    vi.stubEnv("PROVIDER_TRACE_BASE_PATH", path.join(directory, "traces"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "d".repeat(64));
  }, 60_000);
  afterAll(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true }); });

  it.each(["routines", "issues"] as const)("marks overflowed %s incomplete under the negotiated deadline catalog", async family => {
    const now = Date.now(), companyId = randomUUID(), agentId = randomUUID(), ownerId = randomUUID();
    const capability = { deadlineCatalog: "domain_deadlines_v1" } as VerifiedIdleCapabilities;
    const read = () => readIdleSleepSafety(db, () => ({ ownerId, draining: true,
      startedAt: new Date(now - 1000), expiresAt: new Date(now + 300_000), activeRuns: 0, pendingWakes: 0 }),
      () => now, ownerId, async () => "none", undefined, undefined, true, true,
      { deadlineCapability: capability, collectDiagnostics: true });
    const reason = `${family}.schedule`;
    const ids = Array.from({ length: 10_001 }, () => randomUUID());
    const insert = async (batch: string[]) => {
      if (family === "routines") {
        await db.insert(routines).values(batch.map(id => ({ id, companyId, title: "Future routine",
          status: "active", assigneeAgentId: agentId })));
        await db.insert(routineTriggers).values(batch.map(id => ({ id, routineId: id, companyId,
          kind: "schedule", cronExpression: "*/15 * * * *", timezone: "UTC", nextRunAt: new Date(now + 600_000),
          enabled: true, archived: false, setupPending: false })));
      } else {
        await db.insert(issues).values(batch.map(id => ({ id, companyId, title: "Passive backlog", status: "backlog" })));
      }
    };
    await db.insert(companies).values({ id: companyId, name: "Deadline overflow", issuePrefix: `O${companyId.slice(0, 6)}` });
    try {
      await db.insert(agents).values({ id: agentId, companyId, name: "On-demand worker", role: "engineer",
        status: "idle", adapterType: "process" });
      for (let offset = 0; offset < 10_000; offset += 500) await insert(ids.slice(offset, Math.min(offset + 500, 10_000)));
      const atLimit = await read();
      expect(atLimit).toMatchObject({ version: 3, backgroundWork: "none", diagnostics: { complete: true },
        deadlineProof: { catalog: "domain_deadlines_v1" } });
      expect(atLimit.diagnostics?.checks).toContainEqual({ reason, state: "none" });
      if (family === "routines") expect(atLimit.scheduledWake?.nextWakeAt).toBe(new Date(now + 600_000).toISOString());
      else expect(atLimit.scheduledWake).toBeUndefined();

      await insert([ids[10_000]!]);
      const [rowCount] = await db.select({ count: sql<number>`count(*)::integer` })
        .from(family === "routines" ? routines : issues).where(eq(family === "routines" ? routines.companyId : issues.companyId, companyId));
      expect(rowCount?.count).toBe(10_001);
      if (family === "routines") {
        const [triggers] = await db.select({ count: sql<number>`count(*)::integer` }).from(routineTriggers)
          .where(eq(routineTriggers.companyId, companyId));
        expect(triggers?.count).toBe(10_001);
      }
      const overflowed = await read();
      expect(overflowed.backgroundWork).not.toBe("none");
      expect(overflowed.diagnostics?.complete).toBe(false);
      expect(overflowed.diagnostics?.checks).toContainEqual({ reason, state: "unknown" });
      expect(overflowed.deadlineProof).toBeUndefined();
      expect(overflowed.scheduledWake).toBeUndefined();

      if (family === "routines") {
        await db.delete(routines).where(eq(routines.id, ids[10_000]!));
        await db.update(routineTriggers).set({ nextRunAt: new Date(now - 1) }).where(eq(routineTriggers.id, ids[0]!));
      } else {
        await db.delete(issues).where(eq(issues.id, ids[10_000]!));
        await db.update(issues).set({ status: "in_progress", assigneeAgentId: agentId }).where(eq(issues.id, ids[0]!));
      }
      const blocked = await read();
      expect(blocked.backgroundWork).not.toBe("none");
      expect(blocked.diagnostics?.complete).toBe(true);
      expect(blocked.diagnostics?.checks).toContainEqual({ reason, state: "present" });
      expect(blocked.deadlineProof).toBeUndefined();
      expect(blocked.scheduledWake).toBeUndefined();
    } finally {
      await db.delete(routines).where(eq(routines.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  }, 30_000);

  it("projects durable timers across client reconnection and executes the original plugin and trace owners", async () => {
    const now = Date.now(), companyId = randomUUID(), agentId = randomUUID(), pluginId = randomUUID(), runId = randomUUID();
    let hold: { ownerId: string; expiresAt: number } = { ownerId: randomUUID(), expiresAt: now + 300_000 };
    let pluginReceipt: Awaited<ReturnType<NonNullable<PluginWorkerManager["inspectIdleSleep"]>>> | undefined;
    const capability = { deadlineCatalog: "domain_deadlines_v1" } as VerifiedIdleCapabilities;
    let projectionReads = 0;
    const read = (quietPluginIds: string[] = []) => db.transaction(async tx => {
      projectionReads = 0;
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const counted = { select: (...args: unknown[]) => { projectionReads++; return Reflect.apply(tx.select, tx, args); } } as Pick<Db, "select">;
      return readIdleDeadlineProof(counted, hold, { now: Date.now(), verifiedCapability: capability, quietPluginIds,
        quietPluginGeneration: pluginReceipt?.catalogGeneration, quietPluginCatalog: pluginReceipt?.catalog });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await db.insert(companies).values({ id: companyId, name: "Deadline fixture", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Timer", role: "engineer", status: "idle", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } }, createdAt: new Date(now), lastHeartbeatAt: new Date(now) });
    const central = (enabled: boolean, diagnostics = false) => readIdleSleepSafety(db, () => ({ ...hold, ownerId: hold.ownerId,
      draining: true, startedAt: new Date(now - 1000), expiresAt: new Date(hold.expiresAt), activeRuns: 0, pendingWakes: 0 }),
      () => now, hold.ownerId, async () => "none", undefined, undefined, enabled, enabled,
      enabled ? { deadlineCapability: capability, ...(diagnostics ? { collectDiagnostics: true as const } : {}) } : {});
    expect((await central(false)).backgroundWork).toBe("present");
    const negotiated = await central(true);
    expect(negotiated).toMatchObject({ version: 3, backgroundWork: "none", deadlineProof: { catalog: "domain_deadlines_v1" },
      scheduledWake: { version: 2, kind: "domain_deadlines" } });
    expect(negotiated.deadlineProof?.generation).toBe(negotiated.scheduledWake?.generation);
    const initial = await read();
    expect(initial.blocked).toBe(false);
    expect(initial.scheduledWake?.nextWakeAt).toBe(new Date(now + 600_000).toISOString());
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].lastHeartbeatAt?.getTime()).toBe(now);
    await db.$client.end({ timeout: 1 });
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    expect((await read()).scheduledWake).toEqual(initial.scheduledWake);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450 } } }).where(eq(agents.id, agentId));
    const earlier = await read();
    expect(earlier.generation).not.toBe(initial.generation);
    expect(earlier.scheduledWake?.nextWakeAt).toBe(new Date(now + 450_000).toISOString());
    await db.update(agents).set({ lastHeartbeatAt: new Date(now - 600_000) }).where(eq(agents.id, agentId));
    expect((await read()).blocked).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const claimed = await Promise.all([claimDueTimerHeartbeatForAgent(db, agent, new Date(now), 450), claimDueTimerHeartbeatForAgent(db, agent, new Date(now), 450)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(now + 450_000).toISOString());
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "timer",
      startedAt: new Date(now - 1000), finishedAt: new Date(now), costAccountingPending: false });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450, maxDailyRuns: 1 } } }).where(eq(agents.id, agentId));
    const date = new Date(now);
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString());
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450, skipTimerWhenNoActionableWork: true } } }).where(eq(agents.id, agentId));
    expect((await read()).scheduledWake).toBeUndefined();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: "true", intervalSec: 450 } } }).where(eq(agents.id, agentId));
    expect((await read()).blocked).toBe(true);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false } } }).where(eq(agents.id, agentId));
    expect((await read()).scheduledWake).toBeUndefined();
    const noAlarm = await central(true);
    expect(noAlarm).toMatchObject({ version: 3, backgroundWork: "none", deadlineProof: { catalog: "domain_deadlines_v1" } });
    expect(noAlarm.scheduledWake).toBeUndefined();
    expect(noAlarm.deadlineProof?.generation).not.toBe(negotiated.deadlineProof?.generation);
    const scaleIds = Array.from({ length: 160 }, () => randomUUID());
    const scaleAgent = (id: string, cost = false) => ({ id, companyId, name: "Scale timer", role: "engineer", status: "idle", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900, maxDailyRuns: 2, ...(cost ? { maxDailyCostCents: 100 } : {}) } },
      createdAt: new Date(now), lastHeartbeatAt: new Date(now) });
    await db.insert(agents).values(scaleIds.slice(0, 80).map(id => scaleAgent(id)));
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(now + 900_000).toISOString());
    expect(projectionReads).toBe(5);
    await db.insert(agents).values(scaleIds.slice(80).map(id => scaleAgent(id, true)));
    const inactiveIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(agents).values(inactiveIds.map((id, i) => ({ ...scaleAgent(id), status: i === 0 ? "paused" : i === 1 ? "terminated" : "idle",
      ...(i === 2 ? { runtimeConfig: { heartbeat: { enabled: false } } } : {}) })));
    const scaled = await read();
    expect(scaled.blocked).toBe(false);
    expect(scaled.scheduledWake?.nextWakeAt).toBe(new Date(now + 900_000).toISOString());
    expect(projectionReads).toBe(6);
    await db.update(agents).set({ lastHeartbeatAt: new Date(now - 900_000) }).where(eq(agents.id, scaleIds[0]));
    expect((await read()).blocked).toBe(true);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false } } }).where(inArray(agents.id, [...scaleIds, ...inactiveIds]));
    const cancelledScale = await read();
    expect(cancelledScale.scheduledWake).toBeUndefined();
    expect(cancelledScale.generation).not.toBe(scaled.generation);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0.5 } }, lastHeartbeatAt: new Date(now) }).where(eq(agents.id, agentId));
    let checkpointClock = now;
    const becameDue = await readIdleSleepSafety(db, () => ({ ownerId: hold.ownerId, draining: true, startedAt: new Date(now - 1000),
      expiresAt: new Date(hold.expiresAt), activeRuns: 0, pendingWakes: 0 }), () => checkpointClock, hold.ownerId, async () => "none", undefined,
      async () => { const finish = beginIdleTrackedWork(); try { checkpointClock += 1000; return true; } finally { finish(); } },
      true, true, { deadlineCapability: capability });
    expect(becameDue.backgroundWork).toBe("present");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false } } }).where(eq(agents.id, agentId));

    const manifest = { id: `deadline-${pluginId}`, apiVersion: 1 as const, version: "1.0.0", displayName: "Fixture", description: "Deadline fixture", author: "Test",
      categories: [], capabilities: ["jobs.schedule" as const, "plugin.state.write" as const], entrypoints: { worker: "worker.cjs" },
      jobs: [{ jobKey: "hourly", displayName: "Hourly", schedule: "0 * * * *" }] };
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "fixture-plugin", version: manifest.version, status: "ready", manifestJson: manifest });
    const store = pluginJobStore(db), state = pluginStateStore(db), manager = createPluginWorkerManager();
    let allowed = true;
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => allowed, onError: error => errors.push(error) });
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: manager, isBackgroundWorkEnabled: () => allowed, tickIntervalMs: 10 });
    const prepare = async () => {
      allowed = false;
      const lease = startTaskDrain({ purpose: "idle", ttlMs: 300_000 });
      hold = { ownerId: lease.ownerId!, expiresAt: lease.expiresAt!.getTime() };
      pluginReceipt = await manager.inspectIdleSleep!({ ...hold });
      expect(pluginReceipt.backgroundWork).toBe("none");
      return read([pluginId]);
    };
    const resume = () => { stopTaskDrain(); manager.releaseIdleSleep!(); allowed = true; };
    try {
      await manager.startWorker(pluginId, { manifest, apiVersion: 1, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
        entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-deadline.cjs", import.meta.url)),
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
        hostHandlers: { "state.set": async input => {
          if (input.scopeKind !== "instance") throw new Error("Fixture job must publish instance-scoped state");
          await state.set(pluginId, { ...input, scopeKind: "instance" });
        } } });
      await store.syncJobDeclarations(pluginId, manifest.jobs);
      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
      expect((await prepare()).blocked).toBe(true);
      resume();
      await scheduler.start(coordinator);
      await scheduler.tick();
      await store.updateRunTimestamps(job.id, new Date(now - 3_600_000), new Date(now + 900_000));
      expect((await read()).blocked).toBe(true);
      const transferred = await prepare();
      expect(transferred.scheduledWake?.nextWakeAt).toBe(new Date(now + 900_000).toISOString());
      resume();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + 900_001);
      await Promise.all([scheduler.tick(), scheduler.tick()]);
      await expect.poll(async () => (await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job.id))).map(run => run.status), { timeout: 5_000 }).toEqual(["succeeded"]);
      const effects = await db.select().from(pluginState).where(eq(pluginState.pluginId, pluginId));
      const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job.id));
      expect(effects).toHaveLength(1); expect(effects[0].stateKey).toBe(runs[0].id);
      expect(runs[0].finishedAt).not.toBeNull();
      const [after] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, job.id));
      expect(after.nextRunAt!.getTime()).toBeGreaterThan(now + 900_001);
      vi.useRealTimers();
      expect((await prepare()).scheduledWake?.nextWakeAt).toBe(after.nextRunAt!.toISOString());
      resume(); vi.useRealTimers();
      await store.updateJobStatus(job.id, "paused");
      expect(errors).toEqual([]);
    } finally { resume(); vi.useRealTimers(); await scheduler.stop(); await coordinator.stop(); await manager.stopAll(); }
    hold = { ownerId: randomUUID(), expiresAt: Date.now() + 300_000 };
    expect((await read()).scheduledWake).toBeUndefined();

    const traces = providerTraceStore(db);
    const capture = await traces.prepare({ companyId, runId, provider: "opencode", requestedBy: "fixture" });
    expect((await read()).blocked).toBe(true);
    const bytes = JSON.stringify({ kind: "trace_status", status: "complete", debugChannel: "typescript_opencode_native", debugSequence: 1, acknowledgedDebugSequence: 0 }) + "\n";
    await fs.writeFile(capture.path, bytes);
    expect((await traces.finalize(runId, companyId))?.status).toBe("complete");
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(capture.metadata.expiresAt).toISOString());
    const savedCapture = (await traces.getByRun(runId, companyId))!;
    await db.update(providerTraceRecords).set({ status: "deleted", deletedAt: new Date(), traceRef: `s3-segments-v1:${companyId}/${runId}/${randomUUID()}.ndjson` }).where(eq(providerTraceRecords.runId, runId));
    expect((await read()).blocked).toBe(true);
    await db.update(providerTraceRecords).set({ status: "complete", deletedAt: null, traceRef: savedCapture.traceRef }).where(eq(providerTraceRecords.runId, runId));
    await traces.remove(runId, companyId);
    await expect(fs.stat(capture.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await read()).blocked).toBe(false);

    const expiringRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: expiringRunId, companyId, agentId, status: "succeeded", invocationSource: "timer", startedAt: new Date(now), finishedAt: new Date(), costAccountingPending: false });
    const expiring = await traces.prepare({ companyId, runId: expiringRunId, provider: "opencode", requestedBy: "fixture" });
    await fs.writeFile(expiring.path, bytes);
    expect((await traces.finalize(expiringRunId, companyId))?.status).toBe("complete");
    await fs.unlink(expiring.path); await fs.mkdir(expiring.path);
    const expiry = new Date(new Date(expiring.metadata.expiresAt).getTime() + 1);
    await expect(traces.cleanupExpired(expiry)).rejects.toThrow();
    expect((await read()).blocked).toBe(true);
    await fs.rmdir(expiring.path); await fs.writeFile(expiring.path, bytes);
    await traces.cleanupExpired(expiry);
    const cleaned = await traces.getByRun(expiringRunId, companyId);
    expect(cleaned).toMatchObject({ status: "expired", traceRef: "00000000-0000-0000-0000-000000000000.ndjson" });
    await expect(fs.stat(expiring.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await read()).blocked).toBe(false);
    const watched = randomUUID();
    await db.insert(issues).values({ id: watched, companyId, title: "Watchdog grace fixture", status: "done" });
    await db.insert(issueWatchdogs).values({ companyId, issueId: watched, watchdogAgentId: agentId, status: "active" });
    expect((await central(true, true)).diagnostics?.checks).toContainEqual({ reason: "issue_watchdogs", state: "present" });
    const mergeIssue = randomUUID();
    await db.insert(issues).values({ id: mergeIssue, companyId, title: "Merge confirmation fixture", status: "in_review", assigneeAgentId: agentId });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: mergeIssue, kind: "request_confirmation", status: "pending",
      title: "Merge fixture/repo#39?", payload: { version: 1, prompt: "Merge fixture/repo#39?" } });
    expect((await central(true, true)).diagnostics?.checks).toContainEqual({ reason: "issues.schedule", state: "present" });
  }, 30_000);

  it("uses real vault refresh leases, rotates credentials and settles GitHub binding debt after wake", async () => {
    const now = Date.now(), companyId = randomUUID(), owner = "deadline-owner";
    await db.insert(companies).values({ id: companyId, name: "GitHub deadline", issuePrefix: `G${companyId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: "GitHub", type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, uid: randomUUID(), name: "GitHub", status: "active", enabled: true,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", credentialSource: "paperclip_vault", transportConfig: {},
      config: { sourceTemplateKey: "github", oauth: { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "user", subjectUserId: owner, status: "active",
      credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: randomUUID(), versionSelector: "latest" }],
      providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: new Date(now + 8 * 3_600_000).toISOString(), refreshedAt: new Date(now).toISOString() },
        github: { userId: "42", login: "fixture", installationCount: 1, repositoryCount: 1, repositorySelection: "all", installationIds: ["101"],
          installationOwnerLogins: ["fixture"], accessRevision: randomUUID(), lastAccessRefreshAt: new Date(now).toISOString(), webhookHealth: "healthy" } } }).returning();
    const read = () => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      return readIdleGitHubGrantContinuity(tx, Date.now());
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    expect((await read()).blocked).toBe(true);
    const refs = [];
    for (const [configPath, value] of [["oauth.access_token", "saved-access"], ["oauth.refresh_token", "saved-refresh"]] as const) {
      const saved = await writeConnectionCredential(db, { companyId, connectionName: "GitHub", configPath, label: configPath, value, ownerUserId: owner });
      refs.push({ configPath, secretId: saved.secret.id, versionSelector: "latest" as const, required: true });
    }
    await db.update(connectionGrants).set({ credentialSecretRefs: refs }).where(eq(connectionGrants.id, grant.id));
    const vault = secretService(db), credentials = createOAuthCredentialStore(db, vault);
    await credentials.syncCredentialBindings(connection, refs);
    const pinned = await writeConnectionCredential(db, { companyId, connectionName: "GitHub pinned", configPath: "oauth.access_token",
      label: "Pinned access", value: "pinned-initial", ownerUserId: owner });
    const pinnedRef = { configPath: "oauth.access_token", secretId: pinned.secret.id, versionSelector: 1 as const, required: true };
    await writeConnectionCredential(db, { companyId, connectionName: "GitHub pinned", configPath: "oauth.access_token", label: "Pinned access",
      value: "pinned-rotated", ownerUserId: owner, existingRef: pinnedRef });
    await db.update(connectionGrants).set({ credentialSecretRefs: [pinnedRef, refs[1]] }).where(eq(connectionGrants.id, grant.id));
    await credentials.syncCredentialBindings(connection, [pinnedRef, refs[1]]);
    const [pinnedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
    expect((await credentials.resolveOAuthGrantSecret(connection, pinnedGrant, pinnedRef,
      { actorType: "system", actorId: "fixture" }, undefined)).value).toBe("pinned-initial");
    expect((await read()).blocked).toBe(false);
    for (const status of ["disabled", "destroyed"]) {
      await db.update(companySecretVersions).set({ status }).where(eq(companySecretVersions.secretId, pinned.secret.id));
      expect((await read()).blocked).toBe(true);
    }
    await db.update(companySecretVersions).set({ status: "previous", revokedAt: new Date() }).where(eq(companySecretVersions.secretId, pinned.secret.id));
    expect((await read()).blocked).toBe(true);
    await db.update(companySecretVersions).set({ revokedAt: null }).where(eq(companySecretVersions.secretId, pinned.secret.id));
    expect((await read()).blocked).toBe(false);
    await db.update(connectionGrants).set({ credentialSecretRefs: refs }).where(eq(connectionGrants.id, grant.id));
    await credentials.syncCredentialBindings(connection, refs);
    const baseline = await read();
    expect(baseline.blocked).toBe(false);
    expect(baseline.connectionIds).toContain(connection.id);
    expect(new Date(baseline.deadlines[0]).toISOString()).toBe(new Date(now + 7 * 3_600_000).toISOString());
    const getConnection = async () => (await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0];
    const leases = createOAuthRefreshLeases(db, () => new Date(), getConnection, credentials.getOAuthGrantRow);
    let failBindings = true, rotations = 0;
    const successfulBindings = new Map<string, { active: boolean; grantId: string }>();
    const connector = {
      refresh: async (input: Parameters<PaperclipCloudConnector["refresh"]>[0]) => {
        rotations++; expect(input.refreshToken).toBe("saved-refresh"); expect(input.subject).toBe(owner);
        return { v: 1 as const, accessToken: "renewed-access", refreshToken: "renewed-refresh", tokenType: "Bearer", accessTokenExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          refreshTokenExpiresAt: null, scopes: [...GITHUB_CONNECTOR_PROFILES["github.code"].scopes], subject: owner, companyId, instanceId: "fixture", environment: "test" as const, provider: "github" as const, profile: "github.code" };
      },
      setWebhookBinding: async (input: Parameters<PaperclipCloudConnector["setWebhookBinding"]>[0]) => {
        expect(input.accessToken).toBe("renewed-access"); expect(input.companyId).toBe(companyId);
        if (failBindings) throw new Error("named Cloud binding provider unavailable");
        successfulBindings.set(input.id, { active: input.active, grantId: input.grantId });
      },
    } as PaperclipCloudConnector;
    const refresh = createOAuthGrantRefresh(db, { now: () => new Date(), store: credentials, leases, getConnectionRow: getConnection,
      currentCloudConnector: () => connector, exchangeOAuthToken: async () => { throw new Error("Direct OAuth must not run for managed GitHub"); } });
    const continuity = createGitHubGrantContinuity(db, { now: () => new Date(), currentCloudConnector: () => connector,
      refreshOAuthGrantCredentials: refresh, resolveOAuthGrantSecret: credentials.resolveOAuthGrantSecret });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe("https://api.github.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renewed-access");
      const body = url.pathname === "/user" ? { id: 42, login: "fixture" }
        : url.pathname === "/user/installations" ? { installations: [{ id: 101, repository_selection: "all", account: { login: "fixture" } }] }
        : { repositories: [{ id: 999, full_name: "fixture/repo" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + 7 * 3_600_000 + 1);
      expect(await continuity.sweepGitHubConnectionContinuity(companyId)).toMatchObject({ due: 1, failed: 1 });
      expect(rotations).toBe(1);
      const [debt] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      expect(debt.providerTenant?.github?.bindingSync).toBeDefined();
      expect(debt.providerTenant?.github?.continuityRetry).toBeDefined();
      expect((await read()).blocked).toBe(true);
      failBindings = false; vi.setSystemTime(Date.now() + 31_000);
      const reconstructed = createGitHubGrantContinuity(db, { now: () => new Date(), currentCloudConnector: () => connector,
        refreshOAuthGrantCredentials: refresh, resolveOAuthGrantSecret: credentials.resolveOAuthGrantSecret });
      expect(await reconstructed.sweepGitHubConnectionContinuity(companyId)).toMatchObject({ due: 1, failed: 0 });
      expect(rotations).toBe(1); expect(successfulBindings.size).toBe(1);
      const [settled] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      expect(settled.providerTenant?.github?.bindingSync).toBeUndefined();
      expect(settled.providerTenant?.github?.continuityRetry).toBeUndefined();
      const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.id, refs[0].secretId));
      expect(stored.latestVersion).toBe(2);
      expect((await credentials.resolveOAuthGrantSecret(connection, settled, refs[0], { actorType: "system", actorId: "fixture" }, undefined)).value).toBe("renewed-access");
      const after = await read();
      expect(after.blocked).toBe(false); expect(after.connectionIds).toContain(connection.id);
      expect(Math.min(...after.deadlines)).toBeGreaterThan(Date.now());
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 30_000);

});
