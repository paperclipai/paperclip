import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, budgetPolicies, companies, companyMemberships, costEvents, createDb, heartbeatRuns,
  issueComments, issues } from "@paperclipai/db";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { applyOwnershipReportBackstops } from "../services/native-runtime/native-finalization-reconciler.js";
import { promoteDeferredWorkIntents, TEMPORARY_REFUSAL_TRIGGERS, WORK_INTENT_TERMINAL_OUTCOMES } from "../services/work-intent-outbox.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping held comment wake tests: ${recoveryPostgresSupport.reason}`);

/**
 * RC-37: a follow-up comment saved behind a run is promoted when that run ends.
 * Another run's unfinished accounting used to hold company admission and
 * refuse it. Since Phase 3 accounting never gates admission (invariant 3), and
 * each saved intent is delivered exactly once (invariant 4).
 */
describePostgres("saved intents while another run's accounting is pending", () => {
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

  /** The agent's run closed the task, as a native status decision records it. */
  const closeByAgent = (f: { companyId: string; issueId: string; agentId: string }, actorType = "agent") =>
    db.insert(activityLog).values({ companyId: f.companyId, actorType, actorId: actorType === "agent" ? f.agentId : "person",
      action: "issue.updated", entityType: "issue", entityId: f.issueId,
      details: { source: "native_status_decision", fromStatus: "in_progress", toStatus: "done" } });

  /** The comment route's `issue.comment_added` record, which carries the comment's own resume intent. */
  const commentAdded = (f: { companyId: string; issueId: string }, agentId: string, commentId: string, resumeIntent: boolean) =>
    db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: agentId, agentId,
      action: "issue.comment_added", entityType: "issue", entityId: f.issueId,
      details: { commentId, ...(resumeIntent ? { resumeIntent: true, followUpRequested: true } : {}) } });

  async function settle(f: { companyId: string }) {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
  }

  // Phase 3 (invariant 3): another run's unfinished accounting never holds
  // admission. Each intent that used to wait out the accounting hold is now
  // delivered at once, exactly once, and settling accounting later never
  // delivers it again. Before Phase 3 every one of these waited.
  it("delivers a saved comment once while another run's accounting is still pending", async () => {
    const f = await seedHeldComment();
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
    expect((await issueRuns(f)).filter(run => run.status === "cancelled")).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.pendingRunId)))[0].costAccountingPending).toBe(true);
    await settleAccounting(f);
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  it("admits a comment posted during pending accounting at enqueue and delivers it once", async () => {
    // s7532/t06: the enqueue gate refused the comment during the hold.
    const f = await seedHeldComment();
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Posted while accounting is pending." }).returning();
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId });
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => (wake.payload as { commentId?: string }).commentId === comment.id);
    expect(wakes.map(wake => wake.status)).not.toContain("skipped");
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
    await settleAccounting(f);
    await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
  }, 180_000);

  it("starts a Retry clicked while another run's accounting is pending exactly once", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
      idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
    expect(retry).toMatchObject({ accepted: true });
    await settle(f); await settle(f);
    const started = () => issueRuns(f).then(runs => runs.filter(run => run.id !== f.sourceRunId && run.startedAt));
    expect(await started()).toHaveLength(1);
    await settleAccounting(f);
    await settle(f);
    expect(await started()).toHaveLength(1);
  }, 180_000);

  it("starts a new task assigned while another run's accounting is pending", async () => {
    const f = await seedHeldComment();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Created during pending accounting", status: "todo",
      assigneeAgentId: f.agentId, responsibleUserId: f.userId, issueNumber: 2 }).returning();
    await queueIssueAssignmentWakeup({ heartbeat, issue: { id: task.id, assigneeAgentId: f.agentId, status: "todo" },
      reason: "issue_assigned", mutation: "create", contextSource: "issue.create",
      requestedByActorType: "user", requestedByActorId: f.userId, rethrowOnError: true });
    await heartbeat.drainActiveRunExecutions();
    const started = (await issueRuns({ companyId: f.companyId, issueId: task.id })).filter(run => run.startedAt);
    expect(started).toHaveLength(1);
  }, 180_000);

  it("continues a task whose run ended while another run's accounting is pending", async () => {
    const f = await seedHeldComment();
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueRuns(f)).filter(run => run.id !== f.sourceRunId && run.startedAt)).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).not.toBe("blocked");
  }, 180_000);

  // Section E (invariant 4): a pause is the temporary hold left after Phase 3.
  // A message refused by it is saved with its refusal and trigger, promoted
  // by the one hold-release function, and delivered exactly once.
  it.each([
    { hold: "agent pause", refusal: "agent.not_invokable",
      apply: (f: { agentId: string }) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId)),
      lift: (f: { agentId: string }) => db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId)) },
    { hold: "company pause", refusal: "company.inactive",
      apply: (f: { companyId: string }) => db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() })
        .where(eq(companies.id, f.companyId)),
      lift: (f: { companyId: string }) => db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null })
        .where(eq(companies.id, f.companyId)) },
  ])("saves a message refused by a $hold and delivers it once when the pause lifts", async ({ refusal, apply, lift }) => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await apply(f as never);
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Posted during the pause." }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    const saved = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => (wake.payload as { commentId?: string }).commentId === comment.id);
    // Never a terminal skip: one deferred intent naming its refusal and trigger.
    expect(saved).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null,
      payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: refusal, trigger: "pause_lifted" }) }) })]);
    await settle(f);
    expect(deliveries(comment.id)).toHaveLength(0);
    // The pause's own stop sweep (agent lifecycle "pausing") keeps the message
    // it deferred; a terminate or cleanup stop would end it.
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Agent lifecycle stop requested",
      { preservePauseDeferred: true })).toBe(true);
    expect((await readWake(saved[0].id)).status).toBe("deferred_issue_execution");

    await lift(f as never);
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted", issueId: f.issueId }));
    // Promotion skips the 30 s refusal backoff; it does not wait it out.
    expect((await readWake(saved[0].id)).updatedAt.getTime()).toBeLessThanOrEqual(Date.now() - 29_000);
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
    // A repeated release event, or the reconciler backstop, never delivers it twice.
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "reconciler_backstop" }));
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
  }, 180_000);

  // A company pause stops runs asynchronously. A message posted while the
  // task's run is still stopping is saved behind that run, and delivered once
  // after the run ends and the pause lifts.
  it("saves a message posted while the paused company's run is still stopping, and delivers it once", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Posted while the run was stopping." }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    const saved = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => (wake.payload as { commentId?: string }).commentId === comment.id);
    expect(saved).toEqual([expect.objectContaining({ status: "deferred_issue_execution",
      payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: "company.inactive" }) }) })]);
    // The run stops without reading the message; then the pause lifts.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, f.companyId));
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted", issueId: f.issueId }));
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
    await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
  }, 180_000);

  // A pause stops the task's run with a clean, acknowledged cancellation. The
  // release drain never promotes queued work behind an acknowledged stop, so
  // the lifted pause issues the task's next explicit wake, which adopts the
  // saved message once. The pause's own stop sweep keeps the message.
  it("delivers a message saved behind a run the pause stopped, once, after the pause lifts", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ executionRunId: f.sourceRunId }).where(eq(issues.id, f.issueId));
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Posted while the pause stopped the run." }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    // The pause's stop is acknowledged: the run ends cancelled with a clean stop
    // record, and the stop releases the task's execution lock.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Agent lifecycle stop requested",
      { preservePauseDeferred: true })).toBeTypeOf("boolean");
    expect(deliveries(comment.id)).toHaveLength(0);
    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, f.companyId));
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted", issueId: f.issueId }));
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
    await settle(f);
    expect(deliveries(comment.id)).toHaveLength(1);
  }, 180_000);

  // Consumption is per comment: a retry that already received the paused
  // message as task history consumed it, so lifting the pause never sends it
  // again (RC-53 shape through the pause-lift path).
  it("does not replay a paused message that a completed retry already received", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Posted during the pause.", createdAt: new Date(Date.now() - 5_000),
      updatedAt: new Date(Date.now() - 5_000) }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    // A second message, posted later in the pause, that no run has read.
    const [later] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "Also posted during the pause." }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: later.id, mutation: "comment" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: later.id, wakeCommentId: later.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    // A retry of the source run read the whole thread, the first comment included.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(), finishedAt: new Date(), retryOfRunId: f.sourceRunId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry",
        executionContinuation: { messages: [{ id: comment.id }] } } });
    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, f.companyId));
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted", issueId: f.issueId }));
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(0);
    const saved = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      sql`${agentWakeupRequests.payload}->>'commentId' = ${comment.id}`));
    expect(saved).toEqual([expect.objectContaining({ status: "cancelled",
      error: "Queued messages were already delivered to a completed run" })]);
    // The wake that adopts the task's saved messages delivers only the unread one.
    expect(deliveries(later.id)).toHaveLength(1);
  }, 180_000);

  // External chat input resumes only through its live inbound authorization,
  // never through the generic pause-lift wake.
  it("never replays a chat-inbound receipt through the pause-lift path", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: "From an external chat." }).returning();
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: f.userId, idempotencyKey: `chat-inbound:${randomUUID()}`,
      payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment",
        executionWait: { reason: "agent.not_invokable", trigger: "pause_lifted", message: "Agent is paused." },
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, wakeCommentId: comment.id, wakeCommentIds: [comment.id],
          wakeReason: "issue_commented", source: "chat:slack" } } }).returning();
    await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted", issueId: f.issueId }));
    await settle(f); await settle(f);
    expect(deliveries(comment.id)).toHaveLength(0);
    expect((await readWake(receipt.id)).runId).toBeNull();
  }, 180_000);

  // A task that never ran has no terminal run for the release drain to promote
  // a saved message behind. Its message stays in the task, and stranded-work
  // recovery starts the task once the pause lifts.
  it("starts a never-run task commented during an agent pause once the pause lifts", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Never ran", status: "todo",
      assigneeAgentId: f.agentId, responsibleUserId: f.userId, issueNumber: 3 }).returning();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: task.id,
      authorUserId: f.userId, body: "Please start with the FOLLOWUP line." }).returning();
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: task.id, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: task.id, taskId: task.id, commentId: comment.id, wakeCommentId: comment.id,
        source: "issue.comment", wakeReason: "issue_commented" },
      requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => wake.status === "deferred_issue_execution" && (wake.payload as { issueId?: string }).issueId === task.id)).toEqual([]);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const started = (await issueRuns({ companyId: f.companyId, issueId: task.id })).filter(run => run.startedAt);
    expect(started).toHaveLength(1);
  }, 180_000);

  // Chaos s9401/t69: a restart landed between the comment commit (which
  // reopened the finished task to todo) and its wake write. Reconciler rule:
  // an undelivered user comment newer than the task's last run gets a wake.
  it("delivers once a user comment whose wake a restart lost after a succeeded run", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    // The run that finished the task was native, as in the wave, and the
    // comment came after it; the comment's wake was never written.
    await db.update(heartbeatRuns).set({ runtimeMode: "native", startedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(Date.now() - 120_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(issueComments).set({ createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(issueComments.id, f.commentId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId))
      .toEqual([f.commentId]);
    await applyOwnershipReportBackstops(db, report);
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
    // Delivered: the rule no longer fires, and nothing delivers it again.
    const again = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(again.violations.filter(row => row.reason === "user_comment_without_wake")).toEqual([]);
    await applyOwnershipReportBackstops(db, again);
    await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  it("delivers once a comment whose wake a restart lost mid-run on a task the run then closed", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "native", startedAt: new Date(Date.now() - 180_000),
      createdAt: new Date(Date.now() - 180_000), finishedAt: new Date(Date.now() - 30_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(issueComments).set({ createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 120_000) })
      .where(eq(issueComments.id, f.commentId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await closeByAgent(f);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId))
      .toEqual([f.commentId]);
    await applyOwnershipReportBackstops(db, report);
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
    const again = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(again.violations.filter(row => row.reason === "user_comment_without_wake")).toEqual([]);
    await applyOwnershipReportBackstops(db, again);
    await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  // Chaos s9401/t72: a message queued its own run while the first run was
  // finishing. The first run completed the task, so the queued run was
  // cancelled as a stale continuation and the unread message was dropped.
  it("reopens a finished task for a message whose queued run turned stale, and delivers it once", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    // The message's own queued run; the first run then completed the task.
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.issueId, commentId: f.commentId, mutation: "comment" } }).returning();
    const [stale] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wake.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: f.commentId, wakeCommentId: f.commentId,
        wakeCommentIds: [f.commentId], wakeReason: "issue_commented", source: "issue.comment" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: stale.id }).where(eq(agentWakeupRequests.id, wake.id));
    // The first run, which started before the message, completed the task after it.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await closeByAgent(f);
    await settle(f); await settle(f);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stale.id)))[0]).toMatchObject({
      status: "cancelled", errorCode: "continuation_task_ownership_changed" });
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
    await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
  }, 180_000);

  // Staging run 8c71398f: a parent agent posted a comment with `resume: true`
  // ("a changed requirement for your NEXT turn") 90 s after the child's turn
  // ended but before its run settled. The comment queued its own run; the
  // settling run then closed the task, the queued run was cancelled as a stale
  // continuation, and the explicit resume request was never delivered.
  it("reopens a finished task for another agent's explicit resume comment whose queued run turned stale", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const [parent] = await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, "Earlier worker")));
    const [parentRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: parent!.id, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 20_000), finishedAt: new Date(),
      contextSnapshot: {} }).returning();
    const [resume] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: parent!.id,
      createdByRunId: parentRun!.id, body: "Changed requirement for your next turn: revalidate the verdict." }).returning();
    await commentAdded(f, parent!.id, resume!.id, true);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "queued", requestedByActorType: "agent", requestedByActorId: parent!.id,
      payload: { issueId: f.issueId, commentId: resume!.id, mutation: "comment", resumeIntent: true, followUpRequested: true } }).returning();
    const [stale] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wake!.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: resume!.id, wakeCommentId: resume!.id,
        wakeCommentIds: [resume!.id], wakeReason: "issue_commented", source: "issue.comment",
        resumeIntent: true, followUpRequested: true } }).returning();
    await db.update(agentWakeupRequests).set({ runId: stale!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    // The child's run, which started before the comment, closed the task after it.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await closeByAgent(f);
    await settle(f); await settle(f);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stale!.id)))[0]).toMatchObject({
      status: "cancelled", errorCode: "continuation_task_ownership_changed" });
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await settle(f); await settle(f);
    expect(deliveries(resume!.id)).toHaveLength(1);
    await settle(f);
    expect(deliveries(resume!.id)).toHaveLength(1);
  }, 180_000);

  // Queued runs merge comments of several requesters, and the run's wake is
  // rewritten as comments join. The resume intent is each comment's own (its
  // `issue.comment_added` record): another agent's plain note on the same
  // queued run is not promoted, and the resuming agent's comment is not lost,
  // whichever comment came first.
  it.each(["resume first", "resume second"] as const)("keeps each merged comment's own resume intent when two agents share a stale queued run (%s)", async order => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const [resumer] = await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, "Earlier worker")));
    const [notifier] = await db.insert(agents).values({ companyId: f.companyId, name: "Notifier", adapterType, status: "idle",
      adapterConfig: {} }).returning();
    const post = async (authorAgentId: string, body: string, resumeIntent: boolean) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId, body }).returning();
      await commentAdded(f, authorAgentId, comment!.id, resumeIntent);
      return comment!;
    };
    const first = order === "resume first" ? await post(resumer!.id, "Changed requirement for your next turn.", true)
      : await post(notifier!.id, "FYI: unrelated status note.", false);
    const second = order === "resume first" ? await post(notifier!.id, "FYI: unrelated status note.", false)
      : await post(resumer!.id, "Changed requirement for your next turn.", true);
    const resume = order === "resume first" ? first : second, note = order === "resume first" ? second : first;
    // The first comment's wake owns the queued run and now names the joining
    // comment, as claiming a merged run rewrites it; the other wake coalesced.
    const firstAuthor = order === "resume first" ? resumer! : notifier!, secondAuthor = order === "resume first" ? notifier! : resumer!;
    const [primary] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "queued", requestedByActorType: "agent", requestedByActorId: firstAuthor.id,
      payload: { issueId: f.issueId, commentId: second.id, mutation: "comment",
        ...(order === "resume first" ? { resumeIntent: true, followUpRequested: true } : {}) } }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "coalesced", requestedByActorType: "agent", requestedByActorId: secondAuthor.id,
      payload: { issueId: f.issueId, commentId: second.id, mutation: "comment",
        ...(order === "resume second" ? { resumeIntent: true, followUpRequested: true } : {}) } });
    const [stale] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: primary!.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: second.id, wakeCommentId: second.id,
        wakeCommentIds: [first.id, second.id], wakeReason: "issue_commented", source: "issue.comment",
        resumeIntent: true, followUpRequested: true } }).returning();
    await db.update(agentWakeupRequests).set({ runId: stale!.id }).where(eq(agentWakeupRequests.id, primary!.id));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await closeByAgent(f);
    await settle(f); await settle(f);
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await settle(f); await settle(f);
    expect(deliveries(resume.id)).toHaveLength(1);
    expect(deliveries(note.id).filter(turn => !(turn.context.wakeCommentIds as string[]).includes(resume.id))).toHaveLength(0);
    const [saved] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.requestedByActorId, resumer!.id), sql`${agentWakeupRequests.payload}->>'commentId' = ${resume.id}`,
      sql`${agentWakeupRequests.payload}->'_paperclipWakeContext' is not null`));
    expect(saved?.payload).toMatchObject({ resumeIntent: true });
    expect((saved?.payload as { _paperclipWakeContext?: { wakeCommentIds?: string[] } })._paperclipWakeContext?.wakeCommentIds)
      .toEqual([resume.id]);
  }, 180_000);

  // Without `resume: true` an agent's comment stays communicative: the closed
  // task is not reopened for it (issues route: only human comments reopen
  // finished work implicitly).
  it("does not reopen a finished task for another agent's comment without resume intent", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const [parent] = await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, "Earlier worker")));
    const [note] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: parent!.id,
      body: "FYI: the parent review finished." }).returning();
    await commentAdded(f, parent!.id, note!.id, false);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", status: "queued", requestedByActorType: "agent", requestedByActorId: parent!.id,
      payload: { issueId: f.issueId, commentId: note!.id, mutation: "comment" } }).returning();
    const [stale] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wake!.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: note!.id, wakeCommentId: note!.id,
        wakeCommentIds: [note!.id], wakeReason: "issue_commented", source: "issue.comment" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: stale!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await closeByAgent(f);
    await settle(f); await settle(f);
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await settle(f);
    expect(deliveries(note!.id)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.status).toBe("done");
  }, 180_000);

  // The durable half: the stale check ran before the closing run settled (or
  // its save failed), so only the cancelled stale wake carries the message.
  // Once the closing run settles, the reconciler saves it and the drain
  // reopens the task and delivers it once.
  it("recovers a message a stale continuation dropped once the closing run settles", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(),
      error: "continuation_task_ownership_changed" }).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    // A person closed it: that decision stands.
    await closeByAgent(f, "user");
    const byPerson = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(byPerson.violations.filter(row => row.reason === "user_comment_dropped_by_stale_continuation")).toEqual([]);
    // The agent's run closed it later without reading the message.
    await closeByAgent(f);
    // Another message's own turn succeeded later; it did not receive this one.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() + 2_000), finishedAt: new Date(Date.now() + 3_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [randomUUID()],
        executionContinuation: { messages: [{ id: f.commentId }] } } });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(row => row.reason === "user_comment_dropped_by_stale_continuation")
      .map(row => row.recordId)).toEqual([f.commentId]);
    expect(await applyOwnershipReportBackstops(db, report)).toEqual({ retryNeeded: false });
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
    const again = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(again.violations.filter(row => row.recordId === f.commentId)).toEqual([]);
  }, 180_000);

  it("keeps a reconciler pass due when the backstop cannot save a message", async () => {
    const report = { violations: [{ rule: "I4_exactly_once_intent", kind: "issue_comment", recordId: randomUUID(),
      companyId: "not-a-company-id", runId: null, issueId: "not-an-issue-id", reason: "user_comment_without_wake" }], newViolations: [] };
    expect(await applyOwnershipReportBackstops(db, report as never)).toEqual({ retryNeeded: true });
  });

  it("keeps the terminal outcomes closed and every temporary refusal mapped to a release trigger", () => {
    expect([...WORK_INTENT_TERMINAL_OUTCOMES]).toEqual(["delivered", "consumed", "task_cancelled", "hard_stop"]);
    for (const refusal of ["budget.blocked", "company.inactive", "agent.not_invokable", "issue_tree_hold_active",
      "heartbeat.scheduling_suppressed", "wake_lost"]) expect(TEMPORARY_REFUSAL_TRIGGERS[refusal]).toBeTruthy();
  });

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

  it.each([
    { shape: "edited after the later run started", edit: true, startedBeforeComment: false },
    { shape: "posted while the later run was already running", edit: false, startedBeforeComment: true },
  ])("still delivers a saved comment $shape", async ({ edit, startedBeforeComment }) => {
    // A run's recorded context can be refreshed after it starts, and an edit
    // made after it started is unread: neither proves delivery.
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const startedAt = startedBeforeComment ? new Date(Date.now() - 60_000) : new Date();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt, finishedAt: new Date(), retryOfRunId: f.sourceRunId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry",
        executionContinuation: { messages: [{ id: f.commentId }] } } });
    if (edit) await db.update(issueComments).set({ body: "Edited: also include the FOLLOWUP line.", updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(issueComments.id, f.commentId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await settle(f); await settle(f);
    expect(deliveries(f.commentId)).toHaveLength(1);
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

  it("still gives a saved comment its own turn when a later non-retry run only saw it as task history", async () => {
    const f = await seedHeldComment();
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, f.pendingRunId));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [randomUUID()],
        executionContinuation: { messages: [{ id: f.commentId }] } } });
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
