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
import { QUEUED_RECOVERY_RUNS_PER_AGENT } from "../services/recovery-queue-admission.js";
import { PENDING_CONTINUATION_BOUND_MS, assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { evaluateAssignedWork } from "../services/recovery/assigned-work-invariant.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { executionControlSchedule } from "../services/execution-control-work.js";
import { requestTaskRetry } from "../services/task-retry.js";

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

  async function continuationOfInterruptedPersonRetry(agentId: string, createdMinutesAgo: number) {
    const issue = await task(agentId);
    const finishedAt = new Date(Date.now() - (createdMinutesAgo + 2) * 60_000);
    const [retry] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: issue.id } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
      triggerDetail: "manual", status: "interrupted", errorCode: "server_shutdown_interrupted", wakeupRequestId: retry!.id,
      responsibleUserId: userId, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 120_000),
      contextSnapshot: { issueId: issue.id, wakeReason: "task_retry", taskRetryRequestId: retry!.id } }).returning();
    await db.update(agentWakeupRequests).set({ runId: source!.id, status: "completed", finishedAt })
      .where(eq(agentWakeupRequests.id, retry!.id));
    const [continuation] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      invocationSource: "automation", triggerDetail: "system", status: "queued", responsibleUserId: userId,
      createdAt: new Date(Date.now() - createdMinutesAgo * 60_000),
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_continuation_needed", previousRunId: source!.id,
        source: "issue.assigned_work_invariant", assignedWorkViolation: "retry_offered" } }).returning();
    return continuation!;
  }

  it("starts the system continuation of a person's interrupted Retry ahead of fresher system work", async () => {
    const agentId = await seedCompany(1);
    const continuation = await continuationOfInterruptedPersonRetry(agentId, 40);
    const fresher: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) fresher.push(await queuedSystemRun(agentId, 30 - index, "issue_assigned"));
    fresher.push(await queuedRecoveryRun(agentId, 2, 3));
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(continuation.id)).startedAt).not.toBeNull();
      for (const run of fresher) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("keeps a person's Retry first after its system continuation is interrupted again", async () => {
    const agentId = await seedCompany(1);
    const first = await continuationOfInterruptedPersonRetry(agentId, 90);
    const firstEndedAt = new Date(Date.now() - 45 * 60_000);
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted",
      startedAt: new Date(firstEndedAt.getTime() - 60_000), finishedAt: firstEndedAt }).where(eq(heartbeatRuns.id, first.id));
    const [second] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: first.issueId,
      invocationSource: "automation", triggerDetail: "system", status: "queued", responsibleUserId: userId,
      createdAt: new Date(Date.now() - 40 * 60_000),
      contextSnapshot: { issueId: first.issueId, taskId: first.issueId, wakeReason: "issue_continuation_needed",
        previousRunId: first.id, source: "issue.assigned_work_invariant" } }).returning();
    const fresher: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) fresher.push(await queuedSystemRun(agentId, 30 - index, "issue_assigned"));
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(second!.id)).startedAt).not.toBeNull();
      for (const run of fresher) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("starts a system continuation that a person's Retry coalesced into ahead of fresher system work", async () => {
    const agentId = await seedCompany(1);
    const continuation = await queuedSystemRun(agentId, 40, "issue_continuation_needed");
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "coalesced", coalescedCount: 1, requestedByActorType: "user", requestedByActorId: userId,
      runId: continuation.id, finishedAt: new Date(), payload: { issueId: continuation.issueId } });
    const fresher: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) fresher.push(await queuedSystemRun(agentId, 30 - index, "issue_assigned"));
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(continuation.id)).startedAt).not.toBeNull();
      for (const run of fresher) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("gives the longest-waiting queued run a free slot after three fresher starts passed it over", async () => {
    const agentId = await seedCompany(1);
    // A person's run on a todo task, waiting 150 minutes behind fresher person runs on in-progress tasks.
    const old = await queuedPersonRetry(agentId);
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, old.issueId!));
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 150 * 60_000) }).where(eq(heartbeatRuns.id, old.id));
    const fresher: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) fresher.push(await queuedPersonRetry(agentId));
    const issue = await task(agentId);
    for (let index = 0; index < 3; index += 1) {
      const startedAt = new Date(Date.now() - (3 - index) * 60_000);
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
        triggerDetail: "manual", status: "succeeded", createdAt: new Date(startedAt.getTime() - 1_000), startedAt,
        finishedAt: new Date(startedAt.getTime() + 1_000), contextSnapshot: { issueId: issue.id, wakeReason: "issue_recovery_action_restored" } });
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(old.id)).startedAt).not.toBeNull();
      for (const run of fresher) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("keeps a long-waiting recovery run behind people's queued work, even when the oldest-run share is due", async () => {
    const agentId = await seedCompany(1);
    const old = await queuedRecoveryRun(agentId, 150, 152);
    const people: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 3; index += 1) people.push(await queuedPersonRetry(agentId));
    const issue = await task(agentId);
    for (let index = 0; index < 3; index += 1) {
      const startedAt = new Date(Date.now() - (3 - index) * 60_000);
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
        triggerDetail: "manual", status: "succeeded", createdAt: new Date(startedAt.getTime() - 1_000), startedAt,
        finishedAt: new Date(startedAt.getTime() + 1_000), contextSnapshot: { issueId: issue.id, wakeReason: "issue_commented" } });
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect(await readRun(old.id)).toMatchObject({ status: "queued", startedAt: null });
      expect((await Promise.all(people.map(run => readRun(run.id)))).filter(run => run.startedAt)).toHaveLength(1);
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
  // The agent starts its queued recovery runs, which frees their turns in the queue.
  const startQueuedRecovery = async (agentId: string) => db.update(heartbeatRuns)
    .set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' in ('issue_recovery_action_restored', 'issue_continuation_needed')`));
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

  it("leaves a backlog continuation pending while the agent's queue is at its concurrency limit", async () => {
    const agentId = await seedCompany(1);
    const busy = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
      contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
    const record = await pendingContinuation(agentId, 120);
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
    expect(wake).toHaveBeenCalledTimes(2);
    expect(await deliveryOf(held.action.id)).toBe("delivered");
    expect(await deliveryOf(fresh.action.id)).toBe("delivered");
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
        await startQueuedRecovery(agentId);
      }
      expect(admittedAt).toBeGreaterThan(0);
      expect(admittedAt).toBeLessThanOrEqual(bound);
      expect(wake.mock.calls.filter(call => call[1].contextSnapshot.recoveryActionId === old.action.id)).toHaveLength(1);
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
      for (let index = 0; index < 8; index += 1) await pendingContinuation(agentId, 60 + index);
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
    const waiting = await pendingContinuation(agentId, 60);
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
    expect(created.mock.calls.map(call => call[1].contextSnapshot.recoveryActionId)).toContain(overdue.action.id);
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

  it("shows a task as continuing, never as failed, while its recorded continuation is pending past the delivery bound", async () => {
    const agentId = await seedCompany(1);
    const record = await pendingContinuation(agentId, 240);
    await holdPastBound(record, RECOVERY_CONTINUATION_DELIVERY_BOUND_MS);
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, record.issue.id));
    expect(await taskInterruptionPresentation(db, issueRow!)).toMatchObject({ state: "working", responsibility: "system",
      canRetry: true, retryAction: "move_forward", observedRunId: record.source.id });

    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
    expect(wake).toHaveBeenCalledTimes(1);

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
    // Past the bound it is still waiting its turn behind the agent's queued recovery run.
    const waiting = (await sweep.loadFacts(companyId, [issueRow!])).get(held.issue.id)!;
    expect(waiting.pendingWakes).toBe(facts.pendingWakes);
    await startQueuedRecovery(agentId);
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
  async function queueOrdinaryWork(agentId: string, count: number) {
    for (let index = 0; index < count; index += 1) {
      const busy = await task(agentId);
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment", status: "queued",
        contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } });
    }
  }
  const deliveredIds = (wake: ReturnType<typeof fakeWake>) =>
    wake.mock.calls.map(call => String(call[1].contextSnapshot.recoveryActionId));

  it("enqueues a fresh interruption's continuation at once while the agent's queue is deeper than its concurrency limit", async () => {
    const agentId = await seedCompany(1);
    await queueOrdinaryWork(agentId, 3);
    const record = await pendingContinuation(agentId, 3);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(deliveredIds(wake)).toEqual([record.action.id]);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
  }, 60_000);

  it("delivers a fresh interruption ahead of an hours-old backlog for the same agent and keeps draining the backlog", async () => {
    const agentId = await seedCompany(2);
    await queueOrdinaryWork(agentId, 4);
    const backlog: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < 4; index += 1) {
      const record = await pendingContinuation(agentId, 300 + index);
      await holdPastBound(record, (4 * 60 - index) * 60_000);
      backlog.push(record);
    }
    const fresh = await pendingContinuation(agentId, 3);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(deliveredIds(wake)).toEqual([fresh.action.id, backlog[0]!.action.id]);
    for (let pass = 0; pass < backlog.length; pass += 1) {
      await startQueuedRecovery(agentId);
      await deliverReconciledExecutions(db, wake as never);
    }
    expect(await Promise.all(backlog.map(record => deliveryOf(record.action.id)))).toEqual(backlog.map(() => "delivered"));
    expect(wake).toHaveBeenCalledTimes(backlog.length + 1);
  }, 60_000);

  it("enqueues many fresh continuations for one agent one per pass, newest first, and leaves none behind", async () => {
    const agentId = await seedCompany(1);
    await queueOrdinaryWork(agentId, 2);
    const records: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < 5; index += 1) records.push(await pendingContinuation(agentId, 1 + index));
    const wake = fakeWake();
    for (let pass = 0; pass < records.length; pass += 1) {
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).toHaveBeenCalledTimes(pass + 1);
      await startQueuedRecovery(agentId);
    }
    expect(deliveredIds(wake)).toEqual(records.map(record => record.action.id));
  }, 60_000);

  it("queues at most a few recovery runs per agent, holds the rest, and admits the next when one leaves the queue", async () => {
    // paperclip.staging, 2026-11-13: 139 continuations for one agent entered its queue within an hour,
    // because a continuation held past the hold bound was admitted however deep the queue was.
    const agentId = await seedCompany(20);
    await queueOrdinaryWork(agentId, 25);
    const records: Array<Awaited<ReturnType<typeof pendingContinuation>>> = [];
    for (let index = 0; index < 12; index += 1) {
      const record = await pendingContinuation(agentId, index % 2 ? 2 : 200);
      await holdPastBound(record, 60 * 60_000);
      records.push(record);
    }
    const wake = fakeWake();
    for (let pass = 0; pass < 12; pass += 1) await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(QUEUED_RECOVERY_RUNS_PER_AGENT);
    expect((await Promise.all(records.map(record => deliveryOf(record.action.id)))).filter(state => state === "pending"))
      .toHaveLength(records.length - QUEUED_RECOVERY_RUNS_PER_AGENT);
    expect(await executionControlSchedule(db).continuation()).not.toBeNull();

    for (let pass = 0; pass < 2 * records.length && wake.mock.calls.length < records.length; pass += 1) {
      await startQueuedRecovery(agentId);
      await deliverReconciledExecutions(db, wake as never);
      const [queued] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_recovery_action_restored'`));
      expect(Number(queued!.count)).toBeLessThanOrEqual(QUEUED_RECOVERY_RUNS_PER_AGENT);
    }
    expect(await Promise.all(records.map(record => deliveryOf(record.action.id)))).toEqual(records.map(() => "delivered"));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(records.length);
  }, 60_000);

  it("keeps a share of each pass for backlog while fresh interruptions fill the company cap", async () => {
    const freshAgents = [await seedCompany(1)];
    for (let index = 1; index < RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS + 2; index += 1) freshAgents.push(await addAgent(1));
    for (const agentId of freshAgents) await pendingContinuation(agentId, 2);
    const backlogAgent = await addAgent(1);
    const backlog = await pendingContinuation(backlogAgent, 240);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS);
    expect(await deliveryOf(backlog.action.id)).toBe("delivered");
    expect(wake.mock.calls.filter(call => call[0] !== backlogAgent)).toHaveLength(RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS - 1);
  }, 60_000);

  it("delivers a fresh continuation for every agent up to the company cap in one pass when no backlog waits", async () => {
    const agentIds = [await seedCompany(1)];
    for (let index = 1; index < RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS; index += 1) agentIds.push(await addAgent(1));
    const records = [];
    for (const agentId of agentIds) records.push(await pendingContinuation(agentId, 2));
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS);
    expect(await Promise.all(records.map(record => deliveryOf(record.action.id)))).toEqual(records.map(() => "delivered"));
  }, 60_000);

  it("keeps a fresh continuation whose wake was refused pending and enqueues it on the next pass", async () => {
    const agentId = await seedCompany(1);
    await queueOrdinaryWork(agentId, 3);
    const record = await pendingContinuation(agentId, 2);
    const created = fakeWake();
    let refusing = true;
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) =>
      refusing ? null : created(wakeAgentId, opts));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(record.action.id)).toBe("pending");
    refusing = false;
    await deliverReconciledExecutions(db, wake as never);
    expect(created).toHaveBeenCalledTimes(1);
    expect(await deliveryOf(record.action.id)).toBe("delivered");
  }, 60_000);
  it("records why a system wake was folded into the task's pending continuation instead of leaving no trace", async () => {
    const agentId = await seedCompany(1);
    const record = await pendingContinuation(agentId, 30);
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
        payload: { issueId: record.issue.id, mutation: "assigned_work_invariant" }, requestedByActorType: "system",
        contextSnapshot: { issueId: record.issue.id, taskId: record.issue.id, wakeReason: "issue_continuation_needed" } });
      expect(run).toBeNull();
      const rows = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${record.issue.id}`));
      expect(rows).toMatchObject([{ status: "skipped", reason: "issue_continuation_pending" }]);
      expect(await deliveryOf(record.action.id)).toBe("pending");
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);

  async function continuationWaitingInQueue(agentId: string, queuedMinutesAgo: number) {
    const record = await pendingContinuation(agentId, queuedMinutesAgo + 2);
    const wake = fakeWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    const delivered = await wake.mock.results[0]!.value as typeof heartbeatRuns.$inferSelect;
    const [continuation] = await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - queuedMinutesAgo * 60_000) })
      .where(eq(heartbeatRuns.id, delivered.id)).returning();
    const busy = await task(agentId);
    const [olderWork] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment",
      status: "queued", createdAt: new Date(Date.now() - (queuedMinutesAgo + 4) * 60_000),
      contextSnapshot: { issueId: busy.id, wakeReason: "issue_assigned" } }).returning();
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, record.issue.id));
    return { ...record, continuation: continuation!, olderWork: olderWork!, issueRow: issueRow! };
  }

  const runsOfTask = async (issueId: string, sourceRunId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.issueId, issueId), sql`${heartbeatRuns.id} <> ${sourceRunId}`));

  it("moves a continuation that waited 15 minutes forward on a person's Retry, which joins it and starts no second run", async () => {
    const agentId = await seedCompany(1);
    const waiting = await continuationWaitingInQueue(agentId, 16);
    expect(await deliveryOf(waiting.action.id)).toBe("delivered");
    const shown = await taskInterruptionPresentation(db, waiting.issueRow);
    expect(shown).toMatchObject({ responsibility: "system", state: "working", canRetry: true, retryAction: "move_forward",
      observedRunId: waiting.continuation.id });
    const heartbeat = heartbeatService(db);
    try {
      const receipt = await requestTaskRetry({ db, companyId, issueId: waiting.issue.id, actorId: userId,
        observedRunId: shown!.observedRunId, retryAction: shown!.retryAction, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true, stale: false });
      await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
      expect((await runsOfTask(waiting.issue.id, waiting.source.id)).map(run => run.id)).toEqual([waiting.continuation.id]);
      const [retryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(retryWake).toMatchObject({ status: "coalesced", runId: waiting.continuation.id, requestedByActorType: "user" });
      const after = await taskInterruptionPresentation(db, waiting.issueRow);
      expect(after).toMatchObject({ state: "working", canRetry: false });
      expect(after?.retryAction).toBeUndefined();

      await deliverReconciledExecutions(db, fakeWake() as never);
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(waiting.continuation.id)).startedAt).not.toBeNull();
      expect(await readRun(waiting.olderWork.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runsOfTask(waiting.issue.id, waiting.source.id)).map(run => run.id)).toEqual([waiting.continuation.id]);
  }, 120_000);

  it("starts nothing when the continuation ended between showing Move it forward now and the click", async () => {
    const agentId = await seedCompany(1);
    const waiting = await continuationWaitingInQueue(agentId, 16);
    const shown = await taskInterruptionPresentation(db, waiting.issueRow);
    expect(shown).toMatchObject({ canRetry: true, retryAction: "move_forward", observedRunId: waiting.continuation.id });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, waiting.continuation.id));
    const heartbeat = heartbeatService(db);
    try {
      const receipt = await requestTaskRetry({ db, companyId, issueId: waiting.issue.id, actorId: userId,
        observedRunId: shown!.observedRunId, retryAction: shown!.retryAction, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: false, alreadyMovedOn: true, requestId: null });
      await heartbeat.resumeQueuedRuns();
      expect((await runsOfTask(waiting.issue.id, waiting.source.id)).map(run => run.id)).toEqual([waiting.continuation.id]);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.reason, "task_retry"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${waiting.issue.id}`))).toEqual([]);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  async function endContinuationAndRunEveryPass(waiting: Awaited<ReturnType<typeof continuationWaitingInQueue>>,
    heartbeat: ReturnType<typeof heartbeatService>, retryRequestId?: string) {
    await heartbeat.cancelRun(waiting.continuation.id);
    expect(await readRun(waiting.continuation.id)).toMatchObject({ status: "cancelled" });
    for (let pass = 0; pass < 2; pass += 1) {
      await heartbeat.resumeExecutionWaitComments({ companyId });
      if (retryRequestId) await heartbeat.resumeTaskRetry(companyId, retryRequestId);
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      await heartbeat.resumeQueuedRuns();
    }
    return (await runsOfTask(waiting.issue.id, waiting.source.id)).filter(run => run.id !== waiting.continuation.id)
      .map(run => run.contextSnapshot?.wakeReason);
  }

  it("never turns a joined move-forward click into a new run after the continuation it joined ends", async () => {
    let withoutClick: unknown[] = [];
    {
      const agentId = await seedCompany(1);
      const control = await continuationWaitingInQueue(agentId, 16);
      const heartbeat = heartbeatService(db);
      try { withoutClick = await endContinuationAndRunEveryPass(control, heartbeat); }
      finally { await heartbeat.drainActiveRunExecutions(); }
    }
    const agentId = await seedCompany(1);
    const waiting = await continuationWaitingInQueue(agentId, 16);
    const shown = await taskInterruptionPresentation(db, waiting.issueRow);
    const heartbeat = heartbeatService(db);
    try {
      const receipt = await requestTaskRetry({ db, companyId, issueId: waiting.issue.id, actorId: userId,
        observedRunId: shown!.observedRunId, retryAction: shown!.retryAction, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true });
      await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
      await endContinuationAndRunEveryPass(waiting, heartbeat, receipt.requestId!);
      const [retryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(retryWake).toMatchObject({ status: "coalesced", runId: waiting.continuation.id });
      const later = (await runsOfTask(waiting.issue.id, waiting.source.id)).filter(run => run.id !== waiting.continuation.id);
      expect(later.filter(run => run.wakeupRequestId === receipt.requestId || run.contextSnapshot?.wakeReason === "task_retry"
        || run.contextSnapshot?.taskRetryRequestId)).toEqual([]);
      expect(later.map(run => run.contextSnapshot?.wakeReason)).toEqual(withoutClick);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("leaves a continuation that waited under 15 minutes in its place, with no Retry", async () => {
    const agentId = await seedCompany(1);
    const waiting = await continuationWaitingInQueue(agentId, 14);
    const shown = await taskInterruptionPresentation(db, waiting.issueRow);
    expect(shown).toMatchObject({ state: "working", canRetry: false });
    expect(shown?.retryAction).toBeUndefined();
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(waiting.olderWork.id)).startedAt).not.toBeNull();
      expect(await readRun(waiting.continuation.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);
  it("starts the assigned-work sweep's continuation of a task whose run was interrupted, ahead of fresher retries", async () => {
    const agentId = await seedCompany(1);
    const stranded = await task(agentId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: stranded.id, invocationSource: "assignment",
      status: "interrupted", errorCode: "server_shutdown_interrupted", livenessState: "needs_followup",
      startedAt: new Date(Date.now() - 4 * 60 * 60_000), finishedAt: new Date(Date.now() - 3 * 60 * 60_000),
      createdAt: new Date(Date.now() - 4 * 60 * 60_000), contextSnapshot: { issueId: stranded.id, taskId: stranded.id },
      resultJson: { stopReason: "interrupted", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    await db.update(issues).set({ updatedAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(issues.id, stranded.id));
    const heartbeat = heartbeatService(db);
    try {
      const blocker = await queuedRecoveryRun(agentId, 1, 1);
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
      expect(await heartbeat.checkAssignedWorkInvariant({ companyId, issueId: stranded.id }))
        .toMatchObject({ outcome: "repaired" });
      const [continuation] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, stranded.id),
        eq(heartbeatRuns.status, "queued")));
      expect(continuation).toBeDefined();
      await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
        .where(eq(heartbeatRuns.id, continuation!.id));
      const fresher: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (let index = 0; index < 4; index += 1) fresher.push(await queuedRecoveryRun(agentId, 10 - index, 5));
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
      await expect.poll(async () => {
        await heartbeat.resumeQueuedRuns();
        return (await readRun(continuation!.id)).startedAt;
      }, { timeout: 60_000, interval: 250 }).not.toBeNull();
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);
  it("gives system recovery its share when the agent's recent starts were a person's recovery restarts", async () => {
    const agentId = await seedCompany(1);
    const system = await queuedRecoveryRun(agentId, 20, 5);
    for (let index = 0; index < 3; index += 1) {
      const issue = await task(agentId);
      const [request] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_recovery_action_restored", status: "completed", requestedByActorType: "user", requestedByActorId: userId,
        payload: { issueId: issue.id } }).returning();
      const startedAt = new Date(Date.now() - (10 - index) * 60_000);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "on_demand",
        triggerDetail: "manual", status: "succeeded", wakeupRequestId: request!.id, startedAt, finishedAt: startedAt,
        createdAt: new Date(startedAt.getTime() - 1_000),
        contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_recovery_action_restored" } }).returning();
      await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, request!.id));
    }
    // Recovery's share comes out of agent work; with a person's run waiting it would wait too.
    const work: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let index = 0; index < 2; index += 1) {
      const busy = await task(agentId);
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busy.id, invocationSource: "assignment",
        triggerDetail: "system", status: "queued", contextSnapshot: { issueId: busy.id, taskId: busy.id, wakeReason: "issue_assigned" } })
        .returning();
      work.push(row!);
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      expect((await readRun(system.id)).startedAt).not.toBeNull();
      for (const run of work) expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);
});
