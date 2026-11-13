import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS, RECOVERY_CONTINUATION_DELIVERY_BOUND_MS, RECOVERY_CONTINUATION_MAX_HOLD_MS,
  deliverReconciledExecutions,
} from "../services/execution-recovery-resolution.js";
import { PENDING_CONTINUATION_BOUND_MS, assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { evaluateAssignedWork } from "../services/recovery/assigned-work-invariant.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { executionControlSchedule } from "../services/execution-control-work.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("recovery wake herd", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-recovery-wake-herd-");
    db = createDb(temporary.connectionString);
    userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`truncate table company_memberships, issue_recovery_actions, activity_log, agent_wakeup_requests, heartbeat_runs, issues, agents, companies cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seedCompany(maxConcurrentRuns = 1) {
    companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Herd", issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ponytail", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function addAgent(maxConcurrentRuns = 1) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Worker ${agentId.slice(0, 4)}`, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function task(agentId: string, status: "todo" | "in_progress" = "in_progress") {
    const [row] = await db.insert(issues).values({ companyId, title: "Continue the work", status, assigneeAgentId: agentId }).returning();
    return row!;
  }

  async function sourceRun(agentId: string, issueId: string, endedMinutesAgo: number) {
    const finishedAt = new Date(Date.now() - endedMinutesAgo * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment",
      status: "failed", errorCode: "server_shutdown_interrupted", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 120_000), contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return row!;
  }

  async function queuedRecoveryRun(agentId: string, createdMinutesAgo: number, endedMinutesAgo = 180) {
    const issue = await task(agentId);
    const source = await sourceRun(agentId, issue.id, endedMinutesAgo);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "automation",
      triggerDetail: "system", status: "queued", retryOfRunId: source.id, createdAt: new Date(Date.now() - createdMinutesAgo * 60_000),
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_recovery_action_restored", previousRunId: source.id,
        source: "execution.reconciled", forceFreshSession: true } }).returning();
    return row!;
  }

  async function queuedPersonRetry(agentId: string) {
    const issue = await task(agentId);
    const [request] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: issue.id } }).returning();
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
      triggerDetail: "manual", status: "queued", wakeupRequestId: request!.id, responsibleUserId: userId,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_commented" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: row!.id }).where(eq(agentWakeupRequests.id, request!.id));
    return row!;
  }

  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("starts a person's request ahead of a burst of recovery wakes, then runs every recovery wake", async () => {
    const agentId = await seedCompany(1);
    const burst: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 6; index += 1) burst.push(await queuedRecoveryRun(agentId, 60 - index));
    const person = await queuedPersonRetry(agentId);
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(person.id)).startedAt).not.toBeNull();
      for (const run of burst) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
      await expect.poll(async () => {
        await heartbeat.resumeQueuedRuns();
        const states = await Promise.all(burst.map(run => readRun(run.id)));
        return states.filter(run => run.startedAt === null).length;
      }, { timeout: 60_000, interval: 250 }).toBe(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  async function queuedSystemRun(agentId: string, createdMinutesAgo: number, wakeReason: string) {
    const run = await queuedRecoveryRun(agentId, createdMinutesAgo);
    const [row] = await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, wakeReason } })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    return row!;
  }

  it("starts a queued run that a person's comment joined ahead of older system work", async () => {
    const agentId = await seedCompany(1);
    const older: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) older.push(await queuedSystemRun(agentId, 60 - index, "issue_assigned"));
    const joined = await queuedSystemRun(agentId, 50, "issue_reopened_via_comment");
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_same_name", status: "coalesced", coalescedCount: 1, requestedByActorType: "user",
      requestedByActorId: userId, runId: joined.id, finishedAt: new Date(), payload: { issueId: joined.issueId } });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(joined.id)).startedAt).not.toBeNull();
      for (const run of older) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("starts a queued run that adopted a person's comment saved before every queued run", async () => {
    const agentId = await seedCompany(1);
    const [saved] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
      requestedAt: new Date(Date.now() - 90 * 60_000), createdAt: new Date(Date.now() - 90 * 60_000),
      updatedAt: new Date(Date.now() - 90 * 60_000), payload: {} }).returning();
    const older: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) older.push(await queuedSystemRun(agentId, 60 - index, "issue_assigned"));
    const adopting = await queuedSystemRun(agentId, 50, "issue_commented");
    await db.update(agentWakeupRequests).set({ runId: adopting.id, status: "queued", updatedAt: new Date(),
      payload: { issueId: adopting.issueId } }).where(eq(agentWakeupRequests.id, saved!.id));
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(adopting.id)).startedAt).not.toBeNull();
      for (const run of older) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  async function pendingContinuation(agentId: string, endedMinutesAgo: number) {
    const issue = await task(agentId, "todo");
    const source = await sourceRun(agentId, issue.id, endedMinutesAgo);
    const recordedAt = new Date().toISOString();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
      status: "resolved", outcome: "handed_back", resolvedAt: new Date(), ownerType: "board", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${source.id}`,
      nextAction: "Continue the task.", attemptCount: 1,
      evidence: { runId: source.id, originalFailureCode: "server_shutdown_interrupted", continuationDelivery: "pending",
        freshContinuation: { schema: "paperclip.fresh-continuation.v1", reason: "exact_resumption_unavailable", recordedAt },
        freshContinuationSettlement: { recordedAt },
        executionReconciliation: { runId: source.id, observedOutcome: "unknown", disposition: "continue_fresh",
          actorId: "execution-recovery", recordedAt } } }).returning();
    return { issue, source, action: action! };
  }

  function fakeWake() {
    return vi.fn(async (agentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      const issueId = String(opts.contextSnapshot.issueId);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
  }
  const deliveryOf = async (id: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!.evidence.continuationDelivery;
  const finishQueued = async (agentId: string) => db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));

  it("delivers one recovery continuation per agent at a time and drains the rest on later passes", async () => {
    const agentId = await seedCompany(1);
    const records: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < 4; index += 1) records.push(await pendingContinuation(agentId, 120 + index));
    const wake = fakeWake();

    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await Promise.all(records.map(record => deliveryOf(record.action.id)))).filter(state => state === "pending")).toHaveLength(3);
    expect(await executionControlSchedule(db).continuation()).not.toBeNull();

    for (let pass = 0; pass < 10 && wake.mock.calls.length < records.length; pass += 1) {
      await finishQueued(agentId);
      await deliverReconciledExecutions(db, wake as never);
    }
    expect(wake).toHaveBeenCalledTimes(records.length);
    expect(await Promise.all(records.map(record => deliveryOf(record.action.id)))).toEqual(records.map(() => "delivered"));
    expect(await executionControlSchedule(db).continuation()).toBeNull();
  }, 60_000);

  it("leaves a continuation pending while the agent's queue is at its concurrency limit", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
    const record = await pendingContinuation(agentId, 5);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await deliveryOf(record.action.id)).toBe("pending");
    await finishQueued(agentId);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("admits a continuation held past the bound even while ordinary work keeps the queue full", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const record = await pendingContinuation(agentId, 30);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - 1_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: { ...record.action.evidence,
      freshContinuation: { ...(record.action.evidence.freshContinuation as object), recordedAt: heldSince } } })
      .where(eq(issueRecoveryActions.id, record.action.id));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
  }, 60_000);

  it("does not let a fresh interruption keep an older held continuation out of a full queue", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const held = await pendingContinuation(agentId, 90);
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - 1_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: { ...held.action.evidence,
      freshContinuation: { ...(held.action.evidence.freshContinuation as object), recordedAt: heldSince } } })
      .where(eq(issueRecoveryActions.id, held.action.id));
    const fresh = await pendingContinuation(agentId, 1);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(held.action.id)).toBe("delivered");
    expect(await deliveryOf(fresh.action.id)).toBe("pending");
  }, 60_000);

  it("admits an older continuation within a bounded number of passes while fresh interruptions keep arriving", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start - 1_000 });
    try {
      const old = await pendingContinuation(agentId, 120);
      const wake = fakeWake();
      const passInterval = 15_000;
      const bound = Math.ceil(RECOVERY_CONTINUATION_MAX_HOLD_MS / passInterval) + 1;
      let admittedAt = -1;
      for (let pass = 0; pass <= bound && admittedAt < 0; pass += 1) {
        vi.setSystemTime(start + pass * passInterval);
        await pendingContinuation(agentId, 1);
        await deliverReconciledExecutions(db, wake as never);
        if (await deliveryOf(old.action.id) === "delivered") admittedAt = pass;
      }
      expect(admittedAt).toBeGreaterThan(0);
      expect(admittedAt).toBeLessThanOrEqual(bound);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("does not let continuations for busy agents hide other agents' continuations", async () => {
    const busyAgents = [await seedCompany(1)];
    for (let index = 1; index < 4; index += 1) busyAgents.push(await addAgent(1));
    for (const agentId of busyAgents) {
      const busy = await task(agentId);
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
        contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
      for (let index = 0; index < 8; index += 1) await pendingContinuation(agentId, 2 + index);
    }
    const idleAgent = await addAgent(1);
    const idle = await pendingContinuation(idleAgent, 600);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake.mock.calls.map(call => call[0])).toEqual([idleAgent]);
    expect(await deliveryOf(idle.action.id)).toBe("delivered");
  }, 60_000);

  it("caps the continuations one pass delivers per company and delivers the freshest interruption first", async () => {
    const agentIds = [await seedCompany(1)];
    for (let index = 1; index < RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS + 3; index += 1) agentIds.push(await addAgent(1));
    const old: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (const agentId of agentIds.slice(1)) old.push(await pendingContinuation(agentId, 240));
    const fresh = await pendingContinuation(agentIds[0]!, 2);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS);
    expect(wake.mock.calls[0]![0]).toBe(agentIds[0]);
    expect(await deliveryOf(fresh.action.id)).toBe("delivered");
    for (let pass = 0; pass < 5; pass += 1) await deliverReconciledExecutions(db, wake as never);
    expect(await Promise.all(old.map(record => deliveryOf(record.action.id)))).toEqual(old.map(() => "delivered"));
  }, 60_000);

  async function holdPastBound(record: Awaited<ReturnType<typeof pendingContinuation>>, extraMs = 1_000) {
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - extraMs).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: { ...record.action.evidence,
      freshContinuation: { ...(record.action.evidence.freshContinuation as object), recordedAt: heldSince } } })
      .where(eq(issueRecoveryActions.id, record.action.id));
  }

  it("delivers a continuation held past the bound while the agent's queue is full of recovery runs that never start", async () => {
    const agentId = await seedCompany(1);
    await queuedRecoveryRun(agentId, 240);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: (await task(agentId)).id, invocationSource: "automation",
      triggerDetail: "system", status: "queued", createdAt: new Date(Date.now() - 230 * 60_000),
      contextSnapshot: { wakeReason: "issue_continuation_needed" } });
    const record = await pendingContinuation(agentId, 200);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await deliveryOf(record.action.id)).toBe("pending");

    await holdPastBound(record);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toBe(agentId);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
  }, 60_000);

  it("delivers the continuation after a restart while it was pending past the bound with a full queue", async () => {
    const agentId = await seedCompany(1);
    await queuedRecoveryRun(agentId, 240);
    const record = await pendingContinuation(agentId, 200);
    await deliverReconciledExecutions(db, fakeWake() as never);
    expect(await deliveryOf(record.action.id)).toBe("pending");
    await holdPastBound(record, 3 * 60 * 60_000);

    const restartedSchedule = executionControlSchedule(db);
    const due = await restartedSchedule.continuation();
    expect(due).not.toBeNull();
    expect(due!).toBeLessThanOrEqual(Date.now() + 60_000);
    const restartedWake = fakeWake();
    await deliverReconciledExecutions(db, restartedWake as never);
    expect(restartedWake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
    expect(await restartedSchedule.continuation()).toBeNull();
  }, 60_000);

  it("does not let a continuation whose wake cannot enter the queue hold back other continuations", async () => {
    const agentId = await seedCompany(1);
    const stuck: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS; index += 1) {
      const record = await pendingContinuation(await addAgent(1), 300);
      await holdPastBound(record, 60 * 60_000);
      stuck.push(record);
    }
    const sameAgentStuck = await pendingContinuation(agentId, 300);
    await holdPastBound(sameAgentStuck, 60 * 60_000);
    const waiting = await pendingContinuation(agentId, 10);
    await holdPastBound(waiting);
    const stuckIds = new Set([...stuck, sameAgentStuck].map(record => record.action.id));
    const created = fakeWake();
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) =>
      stuckIds.has(String(opts.contextSnapshot.recoveryActionId)) ? null : created(wakeAgentId, opts));
    await deliverReconciledExecutions(db, wake as never);
    expect(created).not.toHaveBeenCalled();
    expect(await deliveryOf(waiting.action.id)).toBe("pending");
    await deliverReconciledExecutions(db, wake as never);
    expect(created).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(waiting.action.id)).toBe("delivered");
  }, 60_000);

  it("delivers an overdue continuation after a temporary refusal while new continuations keep arriving for a full queue", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "on_demand", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "task_retry" } });
    const overdue = await pendingContinuation(agentId, 240);
    await holdPastBound(overdue);
    const created = fakeWake();
    let refusing = true;
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) =>
      refusing ? null : created(wakeAgentId, opts));
    await deliverReconciledExecutions(db, wake as never);
    expect(await deliveryOf(overdue.action.id)).toBe("pending");
    refusing = false;
    for (let pass = 0; pass < 3 && await deliveryOf(overdue.action.id) === "pending"; pass += 1) {
      await pendingContinuation(agentId, 1);
      await deliverReconciledExecutions(db, wake as never);
    }
    expect(await deliveryOf(overdue.action.id)).toBe("delivered");
    expect(created.mock.calls[0]![1].contextSnapshot.recoveryActionId).toBe(overdue.action.id);
  }, 60_000);

  it("delivers another agent's continuation in one pass while one agent refuses a backlog of more than 200", async () => {
    const refusingAgent = await seedCompany(1);
    const heldSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const backlog = await db.insert(issues).values(Array.from({ length: 210 }, () => ({ companyId, title: "Continue the work",
      status: "todo" as const, assigneeAgentId: refusingAgent }))).returning();
    await db.insert(issueRecoveryActions).values(backlog.map(issue => {
      const runId = randomUUID();
      return { companyId, sourceIssueId: issue.id, kind: "active_run_watchdog" as const, status: "resolved" as const,
        outcome: "handed_back" as const, resolvedAt: new Date(heldSince), ownerType: "board" as const, returnOwnerAgentId: refusingAgent,
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`, nextAction: "Continue the task.",
        attemptCount: 1, evidence: { runId, continuationDelivery: "pending",
          freshContinuation: { schema: "paperclip.fresh-continuation.v1", reason: "exact_resumption_unavailable", recordedAt: heldSince },
          executionReconciliation: { runId, observedOutcome: "unknown", disposition: "continue_fresh",
            actorId: "execution-recovery", recordedAt: heldSince } } };
    }));
    const healthy = await pendingContinuation(await addAgent(1), 30);
    const created = fakeWake();
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) =>
      wakeAgentId === refusingAgent ? null : created(wakeAgentId, opts));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake.mock.calls.filter(call => call[0] === refusingAgent)).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(healthy.action.id)).toBe("delivered");
  }, 120_000);

  it("does not show a task as working when its continuation is pending past the delivery bound and nothing runs", async () => {
    const agentId = await seedCompany(1);
    const record = await pendingContinuation(agentId, 240);
    await holdPastBound(record, RECOVERY_CONTINUATION_DELIVERY_BOUND_MS);
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, record.issue.id));
    const presentation = await taskInterruptionPresentation(db, issueRow!);
    expect(presentation?.state).not.toBe("working");

    const fresh = await pendingContinuation(agentId, 30);
    const [freshRow] = await db.select().from(issues).where(eq(issues.id, fresh.issue.id));
    expect(await taskInterruptionPresentation(db, freshRow!)).toMatchObject({ state: "working", canRetry: false });
  }, 60_000);

  it("reads a task whose continuation is held back as waiting for its agent, not idle and not needing Retry", async () => {
    const agentId = await seedCompany(1);
    const queued = await queuedRecoveryRun(agentId, 1);
    const held = await pendingContinuation(agentId, 30);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await deliveryOf(held.action.id)).toBe("pending");
    expect(queued.status).toBe("queued");

    const sweep = assignedWorkSweep(db, { enqueueWakeup: vi.fn(async () => null) });
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, held.issue.id));
    const facts = (await sweep.loadFacts(companyId, [issueRow!])).get(held.issue.id)!;
    expect(facts.pendingWakes).toBeGreaterThan(0);
    expect(evaluateAssignedWork(facts)).toMatchObject({ kind: "ok", clause: "pending_intent", intent: "queued_wake" });

    const presentation = await taskInterruptionPresentation(db, issueRow!);
    expect(presentation).toMatchObject({ canRetry: false, state: "working", responsibility: "system" });

    const recordedAt = new Date(Date.now() - PENDING_CONTINUATION_BOUND_MS - 60_000).toISOString();
    await db.update(issueRecoveryActions).set({ resolvedAt: new Date(recordedAt), evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuation,recordedAt}', to_jsonb(${recordedAt}::text))` }).where(eq(issueRecoveryActions.id, held.action.id));
    const stale = (await sweep.loadFacts(companyId, [issueRow!])).get(held.issue.id)!;
    expect(stale.pendingWakes).toBe(facts.pendingWakes - 1);
  }, 60_000);

  it("re-drives a continuation held past the hold bound even while another recovery run of its agent stays queued", async () => {
    const agentId = await seedCompany(1);
    await queuedRecoveryRun(agentId, 1);
    const held = await pendingContinuation(agentId, 30);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    const heldSince = new Date(Date.now() - RECOVERY_CONTINUATION_MAX_HOLD_MS - 1_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuation,recordedAt}', to_jsonb(${heldSince}::text))` }).where(eq(issueRecoveryActions.id, held.action.id));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(held.action.id)).toBe("delivered");
  }, 60_000);
});
