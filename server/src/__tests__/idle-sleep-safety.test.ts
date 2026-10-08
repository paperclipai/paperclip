import { beginIdleTrackedWork } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentInstructionWorkingCopies, agents, agentApiKeys, agentWakeupRequests, companies, companySecretProposals, createDb,
  adapterAuthSessions, environments, environmentLeases, executionWorkspaces,
  heartbeatRuns, issues, issueWatchdogs, projects, routines, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";

const now = Date.UTC(2020, 0, 1);
const held = (): IdleSleepDrainStatus => ({
  draining: true, startedAt: new Date(now - 1000), expiresAt: new Date(now + 60_000),
  activeRuns: 0, pendingWakes: 0,
});
const unknown = { version: 1, backgroundWork: "unknown" };
const present = { version: 1, backgroundWork: "present" };
const none = { version: 1, backgroundWork: "none" };
const ownerId = "d0b833f4-4098-42de-8420-1907f3aa4895";
const owned = () => ({ ...held(), ownerId });
const emptyLocal = async () => "none" as const;


describe("idle sleep safety failure boundaries", () => {
  it.each([
    { draining: false }, { activeRuns: 1 }, { pendingWakes: 1 },
    { startedAt: null }, { expiresAt: new Date(now) },
  ])("does not query durable work without a quiet admission hold: %j", async (change) => {
    const transaction = vi.fn();
    expect(await readIdleSleepSafety({ transaction } as unknown as Db, () => ({ ...held(), ...change }), () => now))
      .toEqual(unknown);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the database is unavailable", async () => {
    const db = { transaction: vi.fn().mockRejectedValue(new Error("private connection detail")) } as unknown as Db;
    expect(await readIdleSleepSafety(db, held, () => now)).toEqual(unknown);
  });

  it.each([
    { draining: false }, { startedAt: new Date(now) }, { expiresAt: new Date(now) },
    { activeRuns: 1 }, { pendingWakes: 1 },
  ])("rejects a report when the hold changes during the durable scan: %j", async (change) => {
    const getStatus = vi.fn().mockReturnValueOnce(held()).mockReturnValue({ ...held(), ...change });
    const execute = vi.fn().mockResolvedValue([{ blocked: true }]);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }));
    expect(await readIdleSleepSafety({ transaction } as unknown as Db, getStatus, () => now)).toEqual(unknown);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
  });

  it("reports persisted work when the admission hold remains unchanged", async () => {
    const execute = vi.fn().mockResolvedValue([{ blocked: true }]);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }));
    expect(await readIdleSleepSafety({ transaction } as unknown as Db, held, () => now)).toEqual(present);
  });
});

describe("idle sleep admission and local work", () => {
  const emptyDb = () => ({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [{ blocked: false }] }) }) as unknown as Db;
  it("requires the exact current idle owner and a bounded expiry", async () => {
    expect(await readIdleSleepSafety(emptyDb(), held, () => now, undefined, emptyLocal)).toEqual(unknown);
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, "old-owner", emptyLocal)).toEqual(unknown);
    expect(await readIdleSleepSafety(emptyDb(), () => ({ ...owned(), expiresAt: null }), () => now, ownerId, emptyLocal)).toEqual(unknown);
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, emptyLocal)).toEqual(none);
  });
  it.each(["present", "unknown"] as const)("retains local work reported as %s", async state => {
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, async () => state))
      .toEqual({ version: 1, backgroundWork: state });
  });
  it("refuses sleep while accepted work remains in flight", async () => {
    const done = beginIdleTrackedWork();
    try { expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, emptyLocal)).toEqual(unknown); }
    finally { done(); }
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, emptyLocal)).toEqual(none);
  });
  it("invalidates a scan even when concurrent work finishes before the final check", async () => {
    const inspect = async () => { const done = beginIdleTrackedWork(); done(); return "none" as const; };
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, inspect)).toEqual(unknown);
  });
  it("rechecks owner identity after disk inspection, including same-millisecond replacement", async () => {
    let status = owned();
    const inspect = async () => { status = { ...status, ownerId: "replacement" }; return "none" as const; };
    expect(await readIdleSleepSafety(emptyDb(), () => status, () => now, ownerId, inspect)).toEqual(unknown);
  });
  it("rechecks expiry after disk inspection and hides inspection errors", async () => {
    let clock = now;
    expect(await readIdleSleepSafety(emptyDb(), owned, () => clock, ownerId, async () => {
      clock += 60_000; return "none";
    })).toEqual(unknown);
    expect(await readIdleSleepSafety(emptyDb(), owned, () => now, ownerId, async () => { throw new Error("private spool path"); })).toEqual(unknown);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping idle sleep Postgres tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("idle sleep durable work", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("idle-sleep-safety-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await database?.cleanup(); });

  const read = () => readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal);
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle test", issuePrefix: "IDLE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "On-demand agent", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded" });
    return { companyId, agentId, runId };
  }

  it("keeps saved agent files awake until deferred cleanup completes", async () => {
    const { companyId, agentId, runId } = await seed();
    await db.insert(agentInstructionWorkingCopies).values({
      runId, companyId, agentId, responsibleUserId: "test-user", entryFile: "AGENTS.md",
      baseHash: "test-hash", localRoot: "/tmp/idle-copy", executionRoot: "/tmp/idle-copy",
      location: "local", state: "saved", processStoppedAt: new Date(now),
      receipt: { schema: "paperclip.agent-files.v1", cleanupPending: true },
    });
    expect(await read()).toEqual(present);
    await db.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1" } })
      .where(eq(agentInstructionWorkingCopies.runId, runId));
    expect(await read()).toEqual(none);
  });

  it("authorizes an empty database and completed history under a quiet owned hold", async () => {
    expect(await read()).toEqual(none);
    const { companyId } = await seed();
    await db.insert(issues).values({ companyId, title: "Finished work", status: "done" });
    await db.insert(routines).values({ companyId, title: "Paused schedule", status: "paused" });
    await db.insert(environmentLeases).values({ companyId, status: "released" });
    expect(await read()).toEqual(none);
  });

  it("blocks a saved watchdog on a completed issue before its first review starts", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Finished work", status: "done" }).returning();
    expect(await read()).toEqual(none);
    const [watchdog] = await db.insert(issueWatchdogs).values({
      companyId, issueId: issue!.id, watchdogAgentId: agentId, status: "active",
    }).returning();
    expect(watchdog!.watchdogIssueId).toBeNull();
    expect(watchdog!.lastTriggeredAt).toBeNull();
    expect(await read()).toEqual(present);
    await db.update(issueWatchdogs).set({ status: "disabled" }).where(eq(issueWatchdogs.id, watchdog!.id));
    expect(await read()).toEqual(none);
  });

  it.each([
    ["queued run", { status: "queued" }],
    ["orphan running run", { status: "running" }],
    ["future retry", { scheduledRetryAt: new Date(now + 86_400_000) }],
    ["unsettled accounting", { costAccountingPending: true }],
  ] as const)("blocks %s even when process counters are zero", async (_name, change) => {
    const { runId } = await seed();
    await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, runId));
    expect(await read()).toEqual(present);
  });

  it("reports an enabled heartbeat timer and permits sleep after it is disabled", async () => {
    const { agentId } = await seed();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 86_400 } } }).where(eq(agents.id, agentId));
    expect(await read()).toEqual(present);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, intervalSec: 86_400 } } }).where(eq(agents.id, agentId));
    expect(await read()).toEqual(none);
  });

  it("blocks a durable deferred wake", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", status: "deferred_issue_execution" });
    expect(await read()).toEqual(present);
  });

  it("blocks an active routine without waiting for its next due time", async () => {
    const { companyId } = await seed();
    await db.insert(routines).values({ companyId, title: "Tomorrow", status: "active" });
    expect(await read()).toEqual(present);
  });

  it("blocks a remote resource pending cleanup", async () => {
    const { companyId } = await seed();
    await db.insert(environmentLeases).values({ companyId, status: "pending_cleanup" });
    expect(await read()).toEqual(present);
  });

  it("reports a login sandbox awaiting cleanup", async () => {
    const { companyId } = await seed();
    const [environment] = await db.insert(environments).values({ name: "Login fixture" }).returning();
    await db.insert(adapterAuthSessions).values({
      companyId, environmentId: environment!.id, adapterType: "codex_local",
      startedByUserId: "fixture-user", publicSessionId: "fixture-session", status: "cleanup_pending",
    });
    expect(await read()).toEqual(present);
  });

  it("reports a pending secret proposal with future expiry", async () => {
    const { companyId, agentId, runId } = await seed();
    await db.insert(companySecretProposals).values({
      companyId, kind: "secret", proposedName: "Fixture", proposedKey: "FIXTURE",
      justification: "Test pending proposal", proposedByAgentId: agentId, originRunId: runId,
      expiresAt: new Date(now + 86_400_000),
    });
    expect(await read()).toEqual(present);
  });

  it("reports retained execution workspaces that may need delayed cleanup", async () => {
    const { companyId } = await seed();
    const [project] = await db.insert(projects).values({ companyId, name: "Fixture project" }).returning();
    await db.insert(executionWorkspaces).values({
      companyId, projectId: project!.id, name: "Fixture workspace", mode: "isolated",
      strategyType: "git_worktree", status: "closed", cleanupEligibleAt: new Date(now + 86_400_000),
    });
    expect(await read()).toEqual(present);
  });

  it("blocks externally usable agent keys until revoked", async () => {
    const { companyId, agentId } = await seed();
    const [key] = await db.insert(agentApiKeys).values({ companyId, agentId, name: "Fixture", keyHash: "fixture-not-a-key" }).returning();
    expect(await read()).toEqual(present);
    await db.update(agentApiKeys).set({ revokedAt: new Date(now) }).where(eq(agentApiKeys.id, key!.id));
    expect(await read()).toEqual(none);
  });

  it("checks every company in the instance", async () => {
    await seed();
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Other company", issuePrefix: "OTHER" });
    await db.insert(issues).values({ companyId: otherId, title: "Pending work", status: "todo" });
    expect(await read()).toEqual(present);
  });

  it("blocks enabled plugins even without declared jobs or webhooks", async () => {
    await db.execute(sql`INSERT INTO plugins (plugin_key, package_name, version, manifest_json)
      VALUES ('demo.on-demand', 'demo-plugin', '1.0.0', '{}'::jsonb)`);
    expect(await read()).toEqual(present);
    await db.execute(sql`UPDATE plugins SET status = 'disabled'`);
    expect(await read()).toEqual(none);
  });

  it("accepts only exact worker drain receipts and still checks durable work", async () => {
    const [{ id }] = await db.execute<{ id: string }>(sql`INSERT INTO plugins (plugin_key, package_name, version, manifest_json)
      VALUES ('demo.idle', 'demo-idle', '1.0.0', '{}'::jsonb) RETURNING id`);
    const inspect = vi.fn(async () => ({ backgroundWork: "none" as const, pluginIds: [id!] }));
    const scan = () => readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal, inspect);
    expect(await scan()).toEqual(none);
    expect(inspect).toHaveBeenCalledWith({ ownerId, expiresAt: owned().expiresAt!.getTime() });
    await db.execute(sql`INSERT INTO plugins (plugin_key, package_name, version, manifest_json)
      VALUES ('demo.unknown', 'demo-unknown', '1.0.0', '{}'::jsonb)`);
    expect(await scan()).toEqual(present);
    await db.execute(sql`UPDATE plugins SET status = 'disabled' WHERE plugin_key = 'demo.unknown'`);
    const { companyId } = await seed();
    await db.insert(issues).values({ companyId, title: "Still pending", status: "todo" });
    expect(await scan()).toEqual(present);
  });

  it("fails closed when the installed schema is older than the report", async () => {
    await db.execute(sql`ALTER TABLE heartbeat_runs RENAME COLUMN cost_accounting_pending TO hidden_pending`);
    try { expect(await read()).toEqual(unknown); }
    finally { await db.execute(sql`ALTER TABLE heartbeat_runs RENAME COLUMN hidden_pending TO cost_accounting_pending`); }
  });
});
