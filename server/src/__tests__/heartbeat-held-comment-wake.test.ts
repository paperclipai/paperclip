import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, budgetPolicies, companies, companyMemberships, costEvents, createDb, heartbeatRuns,
  issueComments, issues } from "@paperclipai/db";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping held comment wake tests: ${recoveryPostgresSupport.reason}`);

/**
 * RC-37: a follow-up comment saved behind a run is promoted when that run ends.
 * A temporary company admission hold (accounting that is still settling after a
 * restart) can refuse the promoted run before it starts. The comment must stay
 * saved and be delivered exactly once after the hold clears.
 */
describePostgres("a promoted comment refused by a temporary admission hold", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched: Array<{ runId: string; context: Record<string, unknown> }> = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-held-comment-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-held-comment-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push({ runId: input.runId, context: input.context as Record<string, unknown> });
        // The agent finishes the task, so no disposition repair follows.
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A task whose run just ended with a user comment saved behind it, in a
   * company that holds new work while another run's accounting settles. */
  async function seedHeldComment(options: { hardStopReached?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    const userId = `comment-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Commenter", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Held comment fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assignee", adapterType, status: "idle", adapterConfig: {} },
      { id: otherAgentId, companyId, name: "Earlier worker", adapterType, status: "idle", adapterConfig: {} },
    ]);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, windowKind: "calendar_month_utc",
      amount: options.hardStopReached ? 1 : 2_000, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    const [pending] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      costAccountingPending: true, contextSnapshot: {},
      usageJson: { costUsd: 0.01, usageSource: "per_run", billingType: "metered_api", provider: "openai", model: "gpt" } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Task with a follow-up comment", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 30_000), finishedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: userId,
      body: "Also include the FOLLOWUP line." }).returning();
    // The durable receipt the comment route writes while the source run is active.
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId, commentId: comment.id, mutation: "comment", _paperclipWakeContext: {
        issueId, taskId: issueId, commentId: comment.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id],
        wakeReason: "issue_commented", source: "issue.comment" } },
    }).returning();
    return { companyId, agentId, issueId, userId, pendingRunId: pending.id, sourceRunId: source.id, commentId: comment.id, wakeId: wake.id };
  }

  const issueRuns = (f: { companyId: string; issueId: string }) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  const readWake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  const deliveries = (commentId: string) => dispatched.filter(turn =>
    Array.isArray(turn.context.wakeCommentIds) && (turn.context.wakeCommentIds as string[]).includes(commentId));

  /** Settle the other run's accounting through the production path, and
   * return which passive owners it woke. Held work waits on these wakes. */
  async function settleAccounting(f: { pendingRunId: string }) {
    const woken = new Set<string>(), owner = db;
    const stops = [DELIVERY_QUEUES.queuedRunDispatch, DELIVERY_QUEUES.deferredExecutionReceipts, DELIVERY_QUEUES.strandedAssignments]
      .map(queue => subscribeDeliveryWork(owner, queue, () => woken.add(queue)));
    try {
      expect(await accountRunCost(db, f.pendingRunId)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally { for (const stop of stops) stop(); }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.pendingRunId)))[0].costAccountingPending).toBe(false);
    return woken;
  }

  async function settle(f: { companyId: string }) {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
  }

  it("keeps the comment saved through the hold and delivers it exactly once after the hold clears", async () => {
    const f = await seedHeldComment();
    // The source run has ended: the saved comment is promoted while the hold lasts.
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(0);
    // The comment stays pending: either saved or on an unstarted queued run.
    const held = await readWake(f.wakeId);
    expect(["deferred_issue_execution", "queued"]).toContain(held.status);
    const pending = held.runId ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, held.runId)))[0] : null;
    if (pending) expect(pending).toMatchObject({ status: "queued", startedAt: null });
    expect((await issueRuns(f)).filter(run => run.status === "cancelled")).toEqual([]);
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).not.toBe("blocked");

    // Accounting settles and the hold clears. Settlement wakes the held work.
    expect(await settleAccounting(f)).toEqual(new Set([DELIVERY_QUEUES.queuedRunDispatch,
      DELIVERY_QUEUES.deferredExecutionReceipts, DELIVERY_QUEUES.strandedAssignments]));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.id, f.wakeId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);

    // Later sweeps never deliver it again.
    await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  it("keeps a Retry clicked during the hold pending and starts it exactly once after the hold clears", async () => {
    const f = await seedHeldComment();
    // The run the user retries failed; its saved comment was already discarded.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
      idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
    expect(retry).toMatchObject({ accepted: true });
    await settle(f); await settle(f);
    const retried = () => dispatched.filter(turn => turn.context.wakeReason === "task_retry"
      || (turn.context.taskRetry as { generationId?: string } | undefined)?.generationId === retry.requestId);
    expect(retried()).toHaveLength(0);
    const held = await readWake(retry.requestId!);
    expect(["deferred_issue_execution", "queued"]).toContain(held.status);
    expect((await issueRuns(f)).filter(run => run.id !== f.sourceRunId && run.status === "cancelled")).toEqual([]);

    // Nothing polls a held Retry: settling accounting must wake its owner.
    expect(await settleAccounting(f)).toContain(DELIVERY_QUEUES.deferredExecutionReceipts);
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.id, retry.requestId!));
    await settle(f); await settle(f);
    const started = (await issueRuns(f)).filter(run => run.id !== f.sourceRunId && run.startedAt);
    expect(started).toHaveLength(1);
    await settle(f);
    expect((await issueRuns(f)).filter(run => run.id !== f.sourceRunId && run.startedAt)).toHaveLength(1);
  }, 180_000);

  it("starts a new task whose assignment was refused during the hold once accounting settles", async () => {
    const f = await seedHeldComment();
    // A second task is created and assigned while the hold lasts.
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Created during the hold", status: "todo",
      assigneeAgentId: f.agentId, responsibleUserId: f.userId, issueNumber: 2 }).returning();
    await expect(queueIssueAssignmentWakeup({ heartbeat, issue: { id: task.id, assigneeAgentId: f.agentId, status: "todo" },
      reason: "issue_assigned", mutation: "create", contextSource: "issue.create",
      requestedByActorType: "user", requestedByActorId: f.userId, rethrowOnError: true })).rejects.toMatchObject({ status: 409 });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect((await issueRuns({ companyId: f.companyId, issueId: task.id }))).toHaveLength(0);
    // Nothing polls a refused assignment: settling accounting must wake its recovery.
    expect(await settleAccounting(f)).toContain(DELIVERY_QUEUES.strandedAssignments);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const started = (await issueRuns({ companyId: f.companyId, issueId: task.id })).filter(run => run.startedAt);
    expect(started).toHaveLength(1);
  }, 180_000);

  it("waits out the hold instead of blocking a task whose continuation it refused", async () => {
    const f = await seedHeldComment();
    // The task's run ended without settling the task; its comment was already consumed.
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).toBe("in_progress");
    expect((await issueRuns(f)).filter(run => run.id !== f.sourceRunId)).toHaveLength(0);

    await settleAccounting(f);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueRuns(f)).filter(run => run.id !== f.sourceRunId && run.startedAt)).toHaveLength(1);
  }, 180_000);

  it.each([
    { delivery: "task history", context: (commentId: string) => ({ executionContinuation: { messages: [{ id: commentId }] } }) },
    { delivery: "wake input", context: (commentId: string) => ({ wakeCommentIds: [commentId] }) },
  ])("consumes a saved comment that a later completed run already received as $delivery, without reopening it", async ({ context }) => {
    // RC-53: the saved comment's source run was lost; its retry started after
    // the comment, received it in its prompt, finished the task, and only then
    // did the saved wake drain.
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(), finishedAt: new Date(), retryOfRunId: f.sourceRunId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry", ...context(f.commentId) } });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(0);
    expect(await readWake(f.wakeId)).toMatchObject({ status: "cancelled",
      error: "Queued messages were already delivered to a completed run" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
  }, 180_000);

  it("still delivers a saved comment that the later completed run never received", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(), finishedAt: new Date(), retryOfRunId: f.sourceRunId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry", executionContinuation: { messages: [] } } });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  it("still refuses work at a reached hard stop, which the board owns", async () => {
    const f = await seedHeldComment({ hardStopReached: true });
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    // The comment's wake was promoted earlier; a reached hard stop refuses it terminally.
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, provider: "openai", model: "gpt",
      costCents: 50, occurredAt: new Date() });
    await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(0);
    expect(await issueRuns(f).then(runs => runs.filter(run => run.status === "queued"))).toHaveLength(0);
  }, 180_000);
});
