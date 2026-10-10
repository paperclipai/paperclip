import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
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

describe("idle backup checkpoint", () => {
  const database = (blocked = false) => {
    const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ execute: async () => [{ blocked }] }));
    return { db: { transaction } as unknown as Db, transaction };
  };
  const backup = (work: () => Promise<boolean> = async () => true) => vi.fn(async () => {
    const finish = beginIdleTrackedWork();
    try { return await work(); } finally { finish(); }
  });
  it("backs up after durable inspection and rechecks local work before authorizing sleep", async () => {
    const { db, transaction } = database();
    const local = vi.fn(emptyLocal);
    const checkpoint = backup(async () => {
      expect(transaction).toHaveBeenCalledOnce();
      expect(idleWorkSnapshot().active).toBe(1);
      return true;
    });
    expect(await readIdleSleepSafety(db, owned, () => now, ownerId, local, undefined, checkpoint)).toEqual(none);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledTimes(2);
  });
  it.each(["present", "unknown"] as const)("avoids DB probes and backups for known local %s work", async state => {
    const { db, transaction } = database();
    const checkpoint = backup();
    const plugins = vi.fn();
    expect(await readIdleSleepSafety(db, owned, () => now, ownerId, async () => state, plugins, checkpoint))
      .toEqual({ version: 1, backgroundWork: state });
    expect(transaction).not.toHaveBeenCalled();
    expect(plugins).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it("does not start a backup for durable work or an unowned hold", async () => {
    const checkpoint = backup();
    expect(await readIdleSleepSafety(database(true).db, owned, () => now, ownerId, emptyLocal, undefined, checkpoint)).toEqual(present);
    expect(await readIdleSleepSafety(database().db, owned, () => now, "stale", emptyLocal, undefined, checkpoint)).toEqual(unknown);
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it.each(["failed", "threw", "untracked", "concurrent", "expired", "replaced"])("keeps the instance awake when the backup is %s", async kind => {
    let clock = now;
    let status = owned();
    const work = async () => {
      if (kind === "threw") throw new Error("private archive path");
      if (kind === "concurrent") { const finish = beginIdleTrackedWork(); finish(); }
      if (kind === "expired") clock += 60_000;
      if (kind === "replaced") status = { ...status, ownerId: "replacement" };
      return kind !== "failed";
    };
    const checkpoint = kind === "untracked" ? work : backup(work);
    expect(await readIdleSleepSafety(database().db, () => status, () => clock, ownerId, emptyLocal, undefined, checkpoint)).toEqual(unknown);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("retains actual backup work after the owning hold expires", async () => {
    let finishBackup!: () => void;
    const pending = new Promise<void>(resolve => { finishBackup = resolve; });
    const checkpoint = backup(async () => { await pending; return true; });
    let clock = now;
    const scan = readIdleSleepSafety(database().db, owned, () => clock, ownerId, emptyLocal, undefined, checkpoint);
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    clock += 60_000;
    expect(idleWorkSnapshot().active).toBe(1);
    expect(await readIdleSleepSafety(database().db, owned, () => clock, ownerId, emptyLocal)).toEqual(unknown);
    finishBackup();
    expect(await scan).toEqual(unknown);
    expect(idleWorkSnapshot().active).toBe(0);
  });
});


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
    expect(await readIdleSleepSafety(db, held, () => now, undefined, emptyLocal)).toEqual(unknown);
  });

  it.each([
    { draining: false }, { startedAt: new Date(now) }, { expiresAt: new Date(now) },
    { activeRuns: 1 }, { pendingWakes: 1 },
  ])("rejects a report when the hold changes during the durable scan: %j", async (change) => {
    const getStatus = vi.fn().mockReturnValueOnce(held()).mockReturnValue({ ...held(), ...change });
    const execute = vi.fn().mockResolvedValue([{ blocked: true }]);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }));
    expect(await readIdleSleepSafety({ transaction } as unknown as Db, getStatus, () => now, undefined, emptyLocal)).toEqual(unknown);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
  });

  it("reports persisted work when the admission hold remains unchanged", async () => {
    const execute = vi.fn().mockResolvedValue([{ blocked: true }]);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }));
    expect(await readIdleSleepSafety({ transaction } as unknown as Db, held, () => now, undefined, emptyLocal)).toEqual(present);
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
    await db.insert(companies).values({ id: companyId, name: "Idle test", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
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

  it("allows consumed coalesced wakes only after their linked run finishes", async () => {
    const { companyId, agentId, runId } = await seed();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "assignment", status: "coalesced", runId, finishedAt: new Date(now),
    });
    expect(await read()).toEqual(present);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(now) })
      .where(eq(heartbeatRuns.id, runId));
    expect(await read()).toEqual(none);
  });

  it.each(["unfinished", "missing_run", "wrong_company", "wrong_agent", "unfinished_run", "retry", "accounting"])(
    "keeps a coalesced wake awake with %s evidence", async kind => {
      const { companyId, agentId, runId } = await seed();
      await db.update(heartbeatRuns).set({ finishedAt: new Date(now) }).where(eq(heartbeatRuns.id, runId));
      let linkedRunId = runId;
      if (kind === "missing_run") linkedRunId = randomUUID();
      if (kind === "wrong_company") {
        linkedRunId = (await seed()).runId;
        await db.update(heartbeatRuns).set({ finishedAt: new Date(now) }).where(eq(heartbeatRuns.id, linkedRunId));
      }
      if (kind === "wrong_agent") {
        const otherAgentId = randomUUID();
        await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent", role: "engineer", status: "idle", adapterType: "process" });
        await db.update(heartbeatRuns).set({ agentId: otherAgentId }).where(eq(heartbeatRuns.id, runId));
      }
      if (kind === "unfinished_run") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, runId));
      if (kind === "retry") await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, runId));
      if (kind === "accounting") await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "assignment", status: "coalesced", runId: linkedRunId,
        finishedAt: kind === "unfinished" ? null : new Date(now),
      });
      expect(await read()).toEqual(present);
    },
  );

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

  async function seedFinishedLogin() {
    const { companyId } = await seed();
    const [environment] = await db.insert(environments).values({ name: "Finished login fixture" }).returning();
    const [lease] = await db.insert(environmentLeases).values({
      companyId, environmentId: environment!.id, providerLeaseId: "fixture-login-resource",
      status: "released", cleanupStatus: "success", releasedAt: new Date(now),
    }).returning();
    const [session] = await db.insert(adapterAuthSessions).values({
      companyId, environmentId: environment!.id, adapterType: "codex_local",
      startedByUserId: "fixture-user", publicSessionId: "finished-fixture-session",
      status: "authenticated", finishedAt: new Date(now), providerLeaseId: lease!.providerLeaseId,
    }).returning();
    return { companyId, environment: environment!, lease: lease!, session: session! };
  }

  it.each(["authenticated", "completed", "failed", "timed_out", "cancelled"] as const)(
    "permits finished %s login history after confirmed provider cleanup", async status => {
      const { session } = await seedFinishedLogin();
      await db.update(adapterAuthSessions).set({ status }).where(eq(adapterAuthSessions.id, session.id));
      expect(await read()).toEqual(none);
    },
  );

  it.each(["canonical", "uppercase"])("accepts a %s cleanup reference to the internal lease id", async format => {
    const { session, lease } = await seedFinishedLogin();
    await db.update(adapterAuthSessions).set({ providerLeaseId: format === "uppercase" ? lease.id.toUpperCase() : lease.id })
      .where(eq(adapterAuthSessions.id, session.id));
    expect(await read()).toEqual(none);
  });

  it.each(["fixture-provider-id", "00000000-0000-0000-0000-00000000000z", randomUUID()])(
    "accepts cleaned external provider reference %s without an unsafe UUID cast", async providerLeaseId => {
      const { session, lease } = await seedFinishedLogin();
      await db.update(environmentLeases).set({ providerLeaseId }).where(eq(environmentLeases.id, lease.id));
      await db.update(adapterAuthSessions).set({ providerLeaseId }).where(eq(adapterAuthSessions.id, session.id));
      expect(await read()).toEqual(none);
    },
  );

  it("keeps a UUID-shaped external reference awake when an internal lease conflicts", async () => {
    const { companyId, environment, session, lease } = await seedFinishedLogin();
    const conflictingId = randomUUID();
    await db.update(environmentLeases).set({ providerLeaseId: conflictingId }).where(eq(environmentLeases.id, lease.id));
    await db.update(adapterAuthSessions).set({ providerLeaseId: conflictingId }).where(eq(adapterAuthSessions.id, session.id));
    await db.insert(environmentLeases).values({
      id: conflictingId, companyId, environmentId: environment.id,
      status: "released", cleanupStatus: "failed", releasedAt: new Date(now),
    });
    expect(await read()).toEqual(present);
    await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, conflictingId));
    expect(await read()).toEqual(none);
  });

  it("permits terminal login history without a provider resource", async () => {
    const { session } = await seedFinishedLogin();
    await db.update(adapterAuthSessions).set({ providerLeaseId: null }).where(eq(adapterAuthSessions.id, session.id));
    expect(await read()).toEqual(none);
  });

  it.each(["cleanup_pending", "starting", "promoting", "awaiting_code", "submitting", "stored"] as const)(
    "retains %s login work even with an old successful cleanup receipt", async status => {
      const { session } = await seedFinishedLogin();
      await db.update(adapterAuthSessions).set({ status }).where(eq(adapterAuthSessions.id, session.id));
      expect(await read()).toEqual(present);
    },
  );

  it.each(["unfinished", "promotion_claim", "missing_lease", "wrong_company", "wrong_environment", "cleanup_failed", "cleanup_unknown", "unreleased", "conflicting_lease"])(
    "retains terminal login history with %s cleanup evidence", async kind => {
      const { companyId, session, lease, environment } = await seedFinishedLogin();
      if (kind === "unfinished") await db.update(adapterAuthSessions).set({ finishedAt: null }).where(eq(adapterAuthSessions.id, session.id));
      if (kind === "promotion_claim") await db.update(adapterAuthSessions).set({ promotionExpiresAt: new Date(now + 1000) }).where(eq(adapterAuthSessions.id, session.id));
      if (kind === "missing_lease") await db.delete(environmentLeases).where(eq(environmentLeases.id, lease.id));
      if (kind === "wrong_company") await db.update(environmentLeases).set({ companyId: (await seed()).companyId }).where(eq(environmentLeases.id, lease.id));
      if (kind === "wrong_environment") {
        const [other] = await db.insert(environments).values({ name: "Other environment", driver: "sandbox" }).returning();
        await db.update(environmentLeases).set({ environmentId: other!.id }).where(eq(environmentLeases.id, lease.id));
      }
      if (kind === "cleanup_failed") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
      if (kind === "cleanup_unknown") await db.update(environmentLeases).set({ cleanupStatus: null }).where(eq(environmentLeases.id, lease.id));
      if (kind === "unreleased") await db.update(environmentLeases).set({ releasedAt: null }).where(eq(environmentLeases.id, lease.id));
      if (kind === "conflicting_lease") await db.insert(environmentLeases).values({
        companyId, environmentId: environment.id, providerLeaseId: lease.providerLeaseId,
        status: "released", cleanupStatus: "failed", releasedAt: new Date(now),
      });
      expect(await read()).toEqual(present);
    },
  );

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
