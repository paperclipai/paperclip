import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentInstructionWorkingCopies, agents, agentApiKeys, agentWakeupRequests, companies, companySecretProposals, createDb,
  adapterAuthSessions, environments, environmentLeases, executionWorkspaces,
  heartbeatRuns, issues, issueWatchdogs, issueThreadInteractions, issueQuestionResponseDeliveries,
  projects, projectWorkspaces, routines, routineTriggers, toolApplications, toolConnections, workspaceOperations, executionWorkspaceRuntimeLeases, type Db,
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
  const readScheduled = () => readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal, undefined, undefined, true);
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle test", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "On-demand agent", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded" });
    return { companyId, agentId, runId };
  }

  async function scheduledRoutine(at = now + 600_000) {
    const fixture = await seed();
    const [routine] = await db.insert(routines).values({ companyId: fixture.companyId,
      title: "Scheduled fixture", status: "active", assigneeAgentId: fixture.agentId }).returning();
    const [trigger] = await db.insert(routineTriggers).values({ companyId: fixture.companyId,
      routineId: routine!.id, kind: "schedule", cronExpression: "*/15 * * * *", timezone: "UTC",
      nextRunAt: new Date(at), enabled: true, archived: false, setupPending: false }).returning();
    return { ...fixture, routine: routine!, trigger: trigger! };
  }

  it("scheduled routines require the opt-in report and retain their durable definitions", async () => {
    const f = await scheduledRoutine();
    expect(await read()).toEqual(present);
    const result = await readScheduled();
    expect(result).toMatchObject({ version: 2, backgroundWork: "none", scheduledWake: {
      kind: "routines", version: 1, nextWakeAt: new Date(now + 600_000).toISOString(),
    } });
    expect(result.scheduledWake?.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.select().from(routineTriggers).where(eq(routineTriggers.id, f.trigger.id)))
      .toMatchObject([{ nextRunAt: f.trigger.nextRunAt, cronExpression: f.trigger.cronExpression }]);
    expect((await readScheduled()).scheduledWake).toEqual(result.scheduledWake);
  });
  it("scheduled routines cover all companies and invalidate a moved-earlier alarm", async () => {
    await scheduledRoutine(now + 900_000);
    const f = await scheduledRoutine(now + 600_000);
    const first = await readScheduled();
    expect(first.scheduledWake?.nextWakeAt).toBe(new Date(now + 600_000).toISOString());
    await db.update(routineTriggers).set({ nextRunAt: new Date(now + 300_000) }).where(eq(routineTriggers.id, f.trigger.id));
    const edited = await readScheduled();
    expect(edited.scheduledWake?.nextWakeAt).toBe(new Date(now + 300_000).toISOString());
    expect(edited.scheduledWake?.generation).not.toBe(first.scheduledWake?.generation);
  });
  it.each([
    { kind: "webhook" }, { setupPending: true }, { nextRunAt: null },
    { nextRunAt: new Date(now) }, { cronExpression: "bad" }, { timezone: "Unknown/Zone" },
  ])("scheduled routines retain unsupported or due work: %j", async change => {
    const f = await scheduledRoutine();
    await db.update(routineTriggers).set(change).where(eq(routineTriggers.id, f.trigger.id));
    expect(await readScheduled()).toEqual(present);
  });
  it("scheduled routines cannot exempt external API credentials or an unowned hold", async () => {
    const f = await scheduledRoutine();
    expect(await readIdleSleepSafety(db, owned, () => now, "stale", emptyLocal, undefined, undefined, true)).toEqual(unknown);
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId,
      name: "Fixture external automation", keyHash: "fixture-hash" });
    expect(await readScheduled()).toEqual(present);
  });
  it("scheduled routines ignore disabled triggers and fail closed on unknown routine states", async () => {
    const f = await scheduledRoutine();
    await db.update(routineTriggers).set({ enabled: false }).where(eq(routineTriggers.id, f.trigger.id));
    expect(await readScheduled()).toEqual(none);
    await db.update(routines).set({ status: "unknown" }).where(eq(routines.id, f.routine.id));
    expect(await readScheduled()).toEqual(present);
  });
  it("scheduled routines reject a trigger with a different company", async () => {
    const f = await scheduledRoutine();
    const other = await seed();
    await db.update(routineTriggers).set({ companyId: other.companyId }).where(eq(routineTriggers.id, f.trigger.id));
    expect(await readScheduled()).toEqual(present);
  });
  it.each(["checkpoint", "local inspection"])("keeps a routine awake when it becomes due during %s", async stage => {
    await scheduledRoutine(now + 1000);
    let clock = now;
    let inspections = 0;
    const inspect = async () => {
      if (++inspections === 2 && stage === "local inspection") clock += 1000;
      return "none" as const;
    };
    const checkpoint = stage === "checkpoint" ? async () => {
      const done = beginIdleTrackedWork();
      clock += 1000;
      done();
      return true;
    } : undefined;
    expect(await readIdleSleepSafety(db, owned, () => clock, ownerId, inspect, undefined, checkpoint, true)).toEqual(present);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])(
    "permits a finished %s run with a consumed retry date without changing history", async status => {
      const { runId } = await seed();
      const scheduledRetryAt = new Date(now - 1000);
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date(now), scheduledRetryAt }).where(eq(heartbeatRuns.id, runId));
      expect(await read()).toEqual(none);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
        .toMatchObject([{ status, scheduledRetryAt }]);
    },
  );

  it.each([
    { status: "scheduled_retry", finishedAt: new Date(now) },
    { status: "queued", finishedAt: new Date(now) },
    { status: "running", finishedAt: new Date(now) },
    { status: "failed", finishedAt: null },
    { status: "failed", finishedAt: new Date(now), costAccountingPending: true },
    { status: "failed", finishedAt: new Date(now - 2000) },
  ])("retains retry work without terminal consumption proof: %j", async change => {
    const { runId } = await seed();
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now - 1000), ...change }).where(eq(heartbeatRuns.id, runId));
    expect(await read()).toEqual(present);
  });

  it("keeps a live retry child awake after its parent's schedule is consumed", async () => {
    const { companyId, agentId, runId } = await seed();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(now), scheduledRetryAt: new Date(now - 1000) }).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "scheduled_retry", retryOfRunId: runId, scheduledRetryAt: new Date(now + 1000) });
    expect(await read()).toEqual(present);
  });

  async function seedQuestionDelivery(change: Partial<typeof issueQuestionResponseDeliveries.$inferInsert> = {}) {
    const seeded = await seed();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(now) }).where(eq(heartbeatRuns.id, seeded.runId));
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Finished question", status: "done" });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: seeded.companyId, issueId,
      kind: "ask_user_questions", status: "answered", payload: {},
    });
    await db.insert(issueQuestionResponseDeliveries).values({
      companyId: seeded.companyId, issueId, interactionId, sourceRunId: seeded.runId,
      targetRunId: seeded.runId, correlationId: randomUUID(), payloadSha256: "fixture",
      status: "fallback_queued", deliveryMode: "wake_fallback", acknowledgedAt: new Date(now), ...change,
    });
    return { ...seeded, issueId, interactionId };
  }

  async function seedQuestionWake(
    delivery: Awaited<ReturnType<typeof seedQuestionDelivery>>,
    change: Partial<typeof agentWakeupRequests.$inferInsert> = {},
  ) {
    await db.insert(agentWakeupRequests).values({
      companyId: delivery.companyId, agentId: delivery.agentId, source: "automation",
      idempotencyKey: `question-response:${delivery.interactionId}`,
      status: "completed", finishedAt: new Date(now), ...change,
    });
  }

  it.each(["pending", "delivering"])("keeps a %s question delivery awake", async status => {
    await seedQuestionDelivery({ status, acknowledgedAt: null });
    expect(await read()).toEqual(present);
  });

  it.each(["delivered", "fallback_queued"])("permits acknowledged %s history after its target run finishes", async status => {
    await seedQuestionDelivery({ status });
    expect(await read()).toEqual(none);
  });

  it.each(["delivered", "fallback_queued"])("keeps an unacknowledged %s question delivery awake", async status => {
    await seedQuestionDelivery({ status, acknowledgedAt: null });
    expect(await read()).toEqual(present);
  });

  it.each([
    ["queued", { status: "queued", finishedAt: null }],
    ["running", { status: "running", finishedAt: null }],
    ["unfinished", { finishedAt: null }],
    ["retry", { scheduledRetryAt: new Date(now + 1000) }],
    ["accounting", { costAccountingPending: true }],
  ] as const)("keeps an acknowledged question delivery awake with %s target evidence", async (_name, change) => {
    const { runId } = await seedQuestionDelivery();
    await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, runId));
    expect(await read()).toEqual(present);
  });

  it("does not accept a foreign company's finished question target", async () => {
    const foreign = await seedQuestionDelivery({ status: "failed", targetRunId: null });
    await seedQuestionDelivery({ targetRunId: foreign.runId });
    expect(await read()).toEqual(present);
  });

  it("keeps delivered history with a missing target awake", async () => {
    await seedQuestionDelivery({ status: "delivered", targetRunId: null });
    expect(await read()).toEqual(present);
  });

  it("keeps fallback history without a durable wake receipt awake", async () => {
    await seedQuestionDelivery({ targetRunId: null });
    expect(await read()).toEqual(present);
  });

  it.each(["completed", "failed", "cancelled", "skipped", "timed_out"])(
    "permits fallback history after its exact durable wake is %s and finished", async status => {
      const delivery = await seedQuestionDelivery({ targetRunId: null });
      await seedQuestionWake(delivery, { status });
      expect(await read()).toEqual(none);
    },
  );

  it.each(["queued", "deferred_issue_execution", "coalesced"])("keeps an unresolved %s question wake awake", async status => {
    const delivery = await seedQuestionDelivery({ targetRunId: null });
    await seedQuestionWake(delivery, { status, finishedAt: null });
    expect(await read()).toEqual(present);
  });

  it("keeps a terminal question wake without completion evidence awake", async () => {
    const delivery = await seedQuestionDelivery({ targetRunId: null });
    await seedQuestionWake(delivery, { finishedAt: null });
    expect(await read()).toEqual(present);
  });

  it("permits a deferred question fallback after its coalesced continuation finishes", async () => {
    const delivery = await seedQuestionDelivery({ targetRunId: null });
    await seedQuestionWake(delivery, { status: "deferred_issue_execution", finishedAt: null });
    expect(await read()).toEqual(present);
    await db.update(agentWakeupRequests).set({
      status: "coalesced", runId: delivery.runId, finishedAt: new Date(now),
    }).where(eq(agentWakeupRequests.companyId, delivery.companyId));
    expect(await read()).toEqual(none);
  });

  it.each(["missing_run", "wrong_company", "wrong_agent", "unfinished", "retry", "accounting"])(
    "keeps a coalesced question fallback awake with %s linked-run evidence", async kind => {
      const delivery = await seedQuestionDelivery({ targetRunId: null });
      let runId = delivery.runId;
      if (kind === "missing_run") runId = randomUUID();
      if (kind === "wrong_company") runId = (await seedQuestionDelivery({ status: "failed", targetRunId: null })).runId;
      if (kind === "wrong_agent") {
        const otherAgent = randomUUID();
        await db.insert(agents).values({ id: otherAgent, companyId: delivery.companyId, name: "Other", role: "engineer", status: "idle", adapterType: "process" });
        await db.update(heartbeatRuns).set({ agentId: otherAgent }).where(eq(heartbeatRuns.id, runId));
      }
      if (kind === "unfinished") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, runId));
      if (kind === "retry") await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, runId));
      if (kind === "accounting") await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
      await seedQuestionWake(delivery, { status: "coalesced", runId });
      expect(await read()).toEqual(present);
    },
  );

  it("does not accept another interaction's or company's question wake receipt", async () => {
    const delivery = await seedQuestionDelivery({ targetRunId: null });
    await seedQuestionWake(delivery, { idempotencyKey: `question-response:${randomUUID()}` });
    const foreign = await seedQuestionDelivery({ status: "failed", targetRunId: null });
    await seedQuestionWake(delivery, { companyId: foreign.companyId, agentId: foreign.agentId });
    expect(await read()).toEqual(present);
  });

  it("permits failed question-delivery history without a pending target", async () => {
    await seedQuestionDelivery({ status: "failed", targetRunId: null, acknowledgedAt: null });
    expect(await read()).toEqual(none);
  });

  it("still blocks other work after a question handoff finishes", async () => {
    const { issueId } = await seedQuestionDelivery();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    expect(await read()).toEqual(present);
  });

  it("requires a current quiet owner even with completed question history", async () => {
    await seedQuestionDelivery();
    expect(await readIdleSleepSafety(db, owned, () => now, "stale-owner", emptyLocal)).toEqual(unknown);
    expect(await readIdleSleepSafety(db, owned, () => now + 60_001, ownerId, emptyLocal)).toEqual(unknown);
  });

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

  async function seedAiConnection() {
    const seeded = await seed();
    const [application] = await db.insert(toolApplications).values({
      companyId: seeded.companyId, name: "AI fixture", type: "rest_api",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: seeded.companyId, applicationId: application!.id,
      name: "Saved AI login", uid: randomUUID(), connectionPurpose: "ai",
      transport: "runtime_auth", status: "active", enabled: true,
    }).returning();
    return { ...seeded, connection: connection! };
  }

  it("allows saved AI credentials while preserving their connection", async () => {
    const { connection } = await seedAiConnection();
    expect(await read()).toEqual(none);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))
      .toMatchObject([{ status: "active", enabled: true }]);
  });

  it.each(["draft", "active_login", "pending_run", "accepted_refresh"])(
    "keeps AI connections awake for %s work", async kind => {
      const { companyId, runId, connection } = await seedAiConnection();
      if (kind === "draft") await db.update(toolConnections).set({ status: "draft" }).where(eq(toolConnections.id, connection.id));
      if (kind === "pending_run") await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, runId));
      if (kind === "active_login") {
        const [environment] = await db.insert(environments).values({ name: "Active AI login" }).returning();
        await db.insert(adapterAuthSessions).values({
          companyId, environmentId: environment!.id, connectionId: connection.id,
          adapterType: "codex_local", startedByUserId: "fixture-user",
          publicSessionId: randomUUID(), status: "waiting_for_user",
        });
      }
      const finish = kind === "accepted_refresh" ? beginIdleTrackedWork() : undefined;
      try { expect(await read()).toEqual(kind === "accepted_refresh" ? unknown : present); }
      finally { finish?.(); }
    },
  );

  it("retains remote MCP connections alongside inert AI credentials", async () => {
    const { companyId, connection } = await seedAiConnection();
    await db.insert(toolConnections).values({
      companyId, applicationId: connection.applicationId, name: "Remote tools", uid: randomUUID(),
      connectionPurpose: "tool", transport: "mcp_remote", status: "active", enabled: true,
    });
    expect(await read()).toEqual(present);
  });

  async function seedFinishedFailedLease() {
    const seeded = await seed();
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(now) })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [environment] = await db.insert(environments).values({ name: "Failed turn environment", driver: "sandbox" }).returning();
    const leaseId = randomUUID();
    const receipt = {
      schema: "paperclip.remote-termination.v1", companyId: seeded.companyId,
      runId: seeded.runId, leaseId, provider: "plugin:demo:sandbox",
      providerLeaseId: "fixture-resource", state: "destroyed", confirmedAt: new Date(now).toISOString(),
    };
    const [lease] = await db.insert(environmentLeases).values({
      id: leaseId, companyId: seeded.companyId, environmentId: environment!.id,
      heartbeatRunId: seeded.runId, status: "failed", leasePolicy: "ephemeral",
      provider: receipt.provider, providerLeaseId: receipt.providerLeaseId,
      acquiredAt: new Date(now - 1000), releasedAt: new Date(now), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: receipt },
    }).returning();
    return { ...seeded, environment: environment!, lease: lease!, receipt };
  }

  it.each(["destroyed", "stopped"])("allows failed lease history after exact provider %s proof", async state => {
    const { lease, receipt } = await seedFinishedFailedLease();
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: { ...receipt, state } } })
      .where(eq(environmentLeases.id, lease.id));
    expect(await read()).toEqual(none);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))
      .toMatchObject([{ status: "failed", cleanupStatus: "success" }]);
  });

  it("permits consumed retry history only with exact failed-lease termination proof", async () => {
    const { lease, runId } = await seedFinishedFailedLease();
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now - 1000) }).where(eq(heartbeatRuns.id, runId));
    expect(await read()).toEqual(none);
    await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, lease.id));
    expect(await read()).toEqual(present);
  });

  it.each([
    "cleanup_failed", "cleanup_unknown", "unreleased", "retained_policy", "reusable_policy",
    "active", "pending_cleanup", "missing_receipt", "wrong_company", "wrong_run", "wrong_lease",
    "wrong_provider", "wrong_resource", "not_stopped", "missing_run", "unfinished_run",
    "retry", "accounting", "cleanup_in_flight", "pending_export", "pending_retain",
  ])("retains failed leases with %s evidence", async kind => {
    const { lease, receipt, runId } = await seedFinishedFailedLease();
    const change: Partial<typeof environmentLeases.$inferInsert> = {};
    if (kind === "cleanup_failed") change.cleanupStatus = "failed";
    if (kind === "cleanup_unknown") change.cleanupStatus = null;
    if (kind === "unreleased") change.releasedAt = null;
    if (kind === "retained_policy") change.leasePolicy = "retain_on_failure";
    if (kind === "reusable_policy") change.leasePolicy = "reuse_by_environment";
    if (kind === "active" || kind === "pending_cleanup") change.status = kind;
    if (kind === "missing_receipt") change.metadata = {};
    const fields: Record<string, string> = { wrong_company: "companyId", wrong_run: "runId", wrong_lease: "leaseId", wrong_provider: "provider", wrong_resource: "providerLeaseId", not_stopped: "state" };
    if (fields[kind]) change.metadata = { remoteExecutionTermination: { ...receipt, [fields[kind]]: "wrong" } };
    if (kind === "missing_run") change.heartbeatRunId = null;
    if (kind === "unfinished_run") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, runId));
    if (kind === "retry") await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, runId));
    if (kind === "accounting") await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
    if (kind === "cleanup_in_flight") change.metadata = { remoteExecutionTermination: receipt, pendingCleanupInFlight: true };
    if (kind === "pending_export") change.metadata = { remoteExecutionTermination: receipt, nativeWorkspaceExportResume: {} };
    if (kind === "pending_retain") change.metadata = { remoteExecutionTermination: receipt, sandboxStopAndRetain: {} };
    if (Object.keys(change).length) await db.update(environmentLeases).set(change).where(eq(environmentLeases.id, lease.id));
    expect(await read()).toEqual(present);
  });

  it("uses the same failed-lease cleanup proof for finished login history", async () => {
    const { companyId, environment, lease } = await seedFinishedFailedLease();
    await db.insert(adapterAuthSessions).values({
      companyId, environmentId: environment.id, adapterType: "codex_local", startedByUserId: "fixture-user",
      publicSessionId: randomUUID(), providerLeaseId: lease.providerLeaseId,
      status: "authenticated", finishedAt: new Date(now),
    });
    expect(await read()).toEqual(none);
    await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, lease.id));
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

  async function seedRetainedWorkspace(change: Partial<typeof executionWorkspaces.$inferInsert> = {}) {
    const { companyId } = await seed();
    const [project] = await db.insert(projects).values({ companyId, name: "Fixture project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId, projectId: project!.id, name: "Fixture workspace", mode: "isolated_workspace",
      strategyType: "git_worktree", status: "active", providerType: "git_worktree",
      cwd: "/tmp/fixture-retained-worktree", providerRef: "/tmp/fixture-retained-worktree",
      ...change,
    }).returning();
    return workspace!;
  }

  it.each(["local_fs", "git_worktree"].flatMap(providerType =>
    ["active", "idle", "in_review", "archived"].map(status => ({ providerType, status }))))(
    "permits a passive local directory without removing retained data: %j", async ({ providerType, status }) => {
      const metadata = { config: {
        environmentId: randomUUID(), provisionCommand: null, runtimeProvisionCommand: null,
        teardownCommand: null, cleanupCommand: null, workspaceRuntime: null,
        desiredState: null, serviceStates: null,
      }, retainedFixture: true };
      const strategyType = providerType === "local_fs" ? "project_primary" : "git_worktree";
      const workspace = await seedRetainedWorkspace({ providerType, strategyType, status, metadata, cleanupEligibleAt: new Date(Date.UTC(2099, 0, 1)) });
      expect(await read()).toEqual(none);
      expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id)))
        .toMatchObject([{ status, metadata, cwd: workspace.cwd, cleanupEligibleAt: workspace.cleanupEligibleAt }]);
    },
  );

  it.each([null, {}, { config: null }, { config: {} }, { config: { desiredState: "stopped", serviceStates: {} } }])(
    "permits passive local configuration: %j", async metadata => {
      await seedRetainedWorkspace({ metadata });
      expect(await read()).toEqual(none);
    },
  );

  it.each([
    { providerType: "cloud_sandbox" }, { providerType: "future_provider" },
    { strategyType: "adapter_managed" }, { strategyType: "future_strategy" },
    { mode: "future_mode" },
    { providerRef: "another-resource" }, { status: "cleanup_failed" }, { status: "future_state" },
    { cleanupEligibleAt: new Date(now) }, { metadata: { reopenPendingConsumption: true } },
    { metadata: { reopenPendingConsumption: "unknown" } },
    { metadata: { config: [] } }, { metadata: { config: "malformed" } },
    { metadata: { config: { workspaceRuntime: {} } } },
    { metadata: { config: { workspaceRuntime: { services: [] } } } },
    { metadata: { config: { desiredState: "running" } } },
    { metadata: { config: { desiredState: "manual" } } },
    { metadata: { config: { serviceStates: { web: "stopped" } } } },
    { metadata: { config: { provisionCommand: "echo fixture" } } },
    { metadata: { config: { runtimeProvisionCommand: "echo fixture" } } },
    { metadata: { config: { teardownCommand: "echo fixture" } } },
    { metadata: { config: { cleanupCommand: "echo fixture" } } },
    { metadata: { config: { futureWorker: true } } },
  ])("retains a directory with work or unfamiliar state: %j", async change => {
    await seedRetainedWorkspace(change);
    expect(await read()).toEqual(present);
  });

  it("fails closed for malformed directory metadata", async () => {
    const workspace = await seedRetainedWorkspace();
    await db.execute(sql`UPDATE execution_workspaces SET metadata = '[]'::jsonb WHERE id = ${workspace.id}`);
    expect(await read()).toEqual(present);
  });

  it("retains a shared directory that can inherit project runtime configuration", async () => {
    const workspace = await seedRetainedWorkspace();
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({
      companyId: workspace.companyId, projectId: workspace.projectId, name: "Shared fixture",
      metadata: { runtimeConfig: { workspaceRuntime: { services: [] } } },
    }).returning();
    await db.update(executionWorkspaces).set({ mode: "shared_workspace", projectWorkspaceId: projectWorkspace!.id })
      .where(eq(executionWorkspaces.id, workspace.id));
    expect(await read()).toEqual(present);
  });

  it("retains a local directory with an unfinished operation", async () => {
    const workspace = await seedRetainedWorkspace();
    await db.insert(workspaceOperations).values({ companyId: workspace.companyId, executionWorkspaceId: workspace.id, phase: "cleanup", status: "running" });
    expect(await read()).toEqual(present);
  });

  it("retains a local directory with a runtime owner", async () => {
    const workspace = await seedRetainedWorkspace();
    await db.insert(executionWorkspaceRuntimeLeases).values({
      companyId: workspace.companyId, executionWorkspaceId: workspace.id,
      ownerKey: "fixture-owner", lastAction: "use", expiresAt: new Date(Date.UTC(2099, 0, 1)),
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
