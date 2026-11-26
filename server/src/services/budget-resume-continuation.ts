import { and, asc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { agents, budgetResumeClaims, heartbeatRuns, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { budgetCancellationScopePredicate } from "./heartbeat/budget-cancellation.js";
import { AGENT_LIFECYCLE_STOP_REASON } from "./governance-pause-stop.js";

/**
 * Resuming after a budget hard stop continues the work that the stop
 * cancelled, exactly once.
 *
 * When a board member resolves the incident with Raise budget and resume,
 * `markBudgetCancelledWorkForResume` saves a pending `budget_resume_claims` row
 * (the board member and their session source) for every task run this
 * scope's stop cancelled, before the incident closes. That includes runs whose
 * stop has not been delivered yet. Claims live outside the run's result JSON,
 * which terminal writers replace, so a Stop settling at the same moment cannot
 * erase one. The budget-enforcement worker (and the execution-continuation
 * worker as a backstop) calls `deliverBudgetResumeContinuations`: once a run's
 * stop has settled (`cancelled`), it files that board member's Retry.
 * - The Retry path clears the stopped task's execution hold, and accepts only
 *   while the cancelled run is still the task's latest run and the task is
 *   open and assigned, checked under the task lock. Work that already
 *   continued or completed is never repeated.
 * - Its idempotency key names the cancelled run, so every pass, restart or
 *   repeated resume returns the same single request.
 * - The claim and its activity entry settle in one commit.
 * - A Retry starts a new run through normal admission; nothing charges the
 *   cancelled run's provider attempt or failure budget.
 */

/** A claim older than this with no settled outcome belongs to an interrupted dispatcher. */
export const BUDGET_RESUME_CLAIM_STALE_MS = 60_000;
const PAGE_SIZE = 25;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
/** Agent statuses that cannot take a Retry yet but may later: a resume still
 * lifting the agent's hold, or an approval. Their claims wait, unclaimed, and
 * the agent's status change wakes delivery (`notifyBudgetResumeAgentReady`). */
const WAITING_AGENT_STATUSES = ["paused", "pending_approval"] as const;

type BudgetResumeClaim = {
  incidentId: string; actorUserId: string; actorSource: string | null; claimedAt: Date | null;
};

type PrepareChatRetry = NonNullable<Parameters<typeof import("./task-retry.js").requestTaskRetry>[0]["prepareChatRetry"]>;

export type BudgetResumeDelivery = {
  /** The chat service's Retry callback, which connected conversations need. */
  prepareChatRetry?: PrepareChatRetry;
  /** Optional latency nudge; the deferred-receipt worker also dispatches the Retry. */
  resumeTaskRetry?: (companyId: string, requestId: string) => Promise<unknown>;
  /** The Retry path; defaults to requestTaskRetry. Tests substitute refusals. */
  requestRetry?: typeof import("./task-retry.js").requestTaskRetry;
};

const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId')`;

/**
 * Stamp every task run this scope's budget stop cancelled since the incident
 * opened: runs the budget enforcement fenced, and runs the agent lifecycle
 * pause stopped for this budget (the run's `pauseStop` names the agent's
 * budget hold, or the company's budget pause). Runs that already carry a claim
 * keep it, so resolving again is a no-op. Arms the continuation worker in the
 * same commit. Two indexed passes: cancelled runs, and runs whose stop is
 * still being delivered.
 */
export async function markBudgetCancelledWorkForResume(db: Db, input: {
  companyId: string; scopeType: "company" | "agent" | "project"; scopeId: string;
  incidentId: string; incidentOpenedAt: Date; actorUserId: string; actorSource?: string | null;
}): Promise<string[]> {
  return db.transaction(async tx => {
    // Register the work signals before the write they announce: the budget
    // worker delivers claims; the execution-continuation worker is a backstop.
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.budgetEnforcement, input.companyId);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    const openedAt = input.incidentOpenedAt.toISOString();
    // The pause records the holds it stopped the run for (pauseStop). Only a
    // stop this budget caused qualifies: the agent's own budget hold, or the
    // company's budget pause. A manual pause never does. The holds come from
    // the lifecycle operation's pauseCause, saved when the pause started, so a
    // resume that removed the holds before the Stop ran still leaves them here.
    const pauseStop = sql`${heartbeatRuns.resultJson}->'pauseStop'`;
    const lifecycleStop = input.scopeType === "project" ? sql`false` : and(
      sql`${heartbeatRuns.resultJson}->'cancellation'->>'reason' = ${AGENT_LIFECYCLE_STOP_REASON}`,
      sql`${heartbeatRuns.resultJson}->'cancellation'->'initiator'->>'type' = 'system'`,
      input.scopeType === "agent"
        ? and(eq(heartbeatRuns.agentId, input.scopeId), sql`(${pauseStop}->'holds') ? 'budget'`)
        : sql`(${pauseStop}->'holds') ? 'company_paused' and ${pauseStop}->>'companyPauseReason' = 'budget'`)!;
    // A run still active on an agent whose pause this budget caused: the
    // pause's Stop may land after the incident closes. The lifecycle operation
    // recorded the cause when the pause started (pauseCause).
    const pauseCause = sql`a.lifecycle_operation->'pauseCause'`;
    const pendingPauseStop = input.scopeType === "project" ? sql`false` : sql`exists (select 1 from agents a
      where a.id = ${heartbeatRuns.agentId} and a.company_id = ${heartbeatRuns.companyId}
        and a.lifecycle_state = 'pausing'
        and ${input.scopeType === "agent"
          ? sql`a.id = ${input.scopeId} and (${pauseCause}->'holds') ? 'budget'`
          : sql`(${pauseCause}->'holds') ? 'company_paused' and ${pauseCause}->>'companyPauseReason' = 'budget'`})`;
    // A queued run that admission cancelled for this budget's board-owned block.
    // Admission saves the stamp before it cancels; the recorded cancellation
    // must carry the stamp's reason, so a stamped run that later ran, or was
    // cancelled for another reason, never matches.
    const admissionStop = and(
      sql`${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'scopeType' = ${input.scopeType}`,
      sql`${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'scopeId' = ${input.scopeId}`,
      sql`${heartbeatRuns.resultJson}->'cancellation'->>'reason' = ${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'reason'`)!;
    const stoppedByThisScope = or(budgetCancellationScopePredicate(input), lifecycleStop, admissionStop)!;
    // A queued run admission stamped for this budget but has not cancelled
    // yet. Delivery waits for its Stop, and abandons the claim if the run was
    // cancelled for another reason.
    const pendingAdmissionStop = and(
      sql`${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'scopeType' = ${input.scopeType}`,
      sql`${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'scopeId' = ${input.scopeId}`)!;
    // A person's Stop stays stopped, even if budget enforcement also fenced
    // the run while that Stop was being delivered.
    const stoppedByPerson = sql`(coalesce(${heartbeatRuns.resultJson}->'cancellation'->'initiator'->>'type', '') = 'user'
      or coalesce(${heartbeatRuns.resultJson}->'cancellation'->>'source', '') = 'operator'
      or coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') in ('user', 'board'))`;
    const claimable = and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`not ${stoppedByPerson}`,
      sql`${runIssueId} is not null`,
    );
    const stoppedSinceIncident = and(stoppedByThisScope,
      sql`coalesce((${heartbeatRuns.resultJson}->'startupCancellation'->>'requestedAt')::timestamptz,
        ${heartbeatRuns.updatedAt}) >= ${openedAt}::timestamptz`)!;
    // Both passes lead with (company_id, status), which the company status
    // indexes serve. A run that finished any other way is owed nothing. An
    // existing claim is kept, so resolving again saves nothing new.
    const claim = (status: ReturnType<typeof eq>) => tx.insert(budgetResumeClaims).select(
      tx.select({ runId: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
        incidentId: sql<string>`${input.incidentId}::uuid`.as("incident_id"),
        actorUserId: sql<string>`${input.actorUserId}`.as("actor_user_id"),
        actorSource: sql<string | null>`${input.actorSource ?? null}::text`.as("actor_source"),
        state: sql<string>`'pending'`.as("state"),
        claimedAt: sql<Date | null>`null::timestamptz`.as("claimed_at"),
        settledAt: sql<Date | null>`null::timestamptz`.as("settled_at"),
        reason: sql<string | null>`null::text`.as("reason"),
        requestId: sql<string | null>`null::uuid`.as("request_id"),
        createdAt: sql<Date>`now()`.as("created_at"),
      }).from(heartbeatRuns).where(and(claimable, status)),
    ).onConflictDoNothing().returning({ id: budgetResumeClaims.runId });
    const finished = await claim(and(eq(heartbeatRuns.status, "cancelled"), stoppedSinceIncident) as ReturnType<typeof eq>);
    // Active runs are being stopped now: fenced by this budget's enforcement,
    // or on an agent whose budget pause has not delivered its Stop yet.
    const active = await claim(and(inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
      or(stoppedSinceIncident, pendingPauseStop, pendingAdmissionStop)) as ReturnType<typeof eq>);
    return [...finished, ...active].map(row => row.id);
  });
}

/** Compare-and-set the run's claim. Only the writer that wins dispatches. */
async function setClaim(db: Pick<Db, "update">, input: {
  runId: string; expectedClaimedAt: Date | null;
  next: Partial<Pick<typeof budgetResumeClaims.$inferInsert, "state" | "claimedAt" | "settledAt" | "reason" | "requestId">>;
}) {
  const [row] = await db.update(budgetResumeClaims).set(input.next).where(and(
    eq(budgetResumeClaims.runId, input.runId), eq(budgetResumeClaims.state, "pending"),
    input.expectedClaimedAt === null ? isNull(budgetResumeClaims.claimedAt)
      : sql`date_trunc('milliseconds', ${budgetResumeClaims.claimedAt}) = ${input.expectedClaimedAt.toISOString()}::timestamptz`,
  )).returning({ id: budgetResumeClaims.runId });
  return Boolean(row);
}

/** True while a resumed budget stop still owes a continuation. */
export async function hasPendingBudgetResume(db: Db) {
  const [row] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .where(eq(budgetResumeClaims.state, "pending")).limit(1);
  return Boolean(row);
}

/** True when this run carries a pending resume claim (a primary-key lookup). */
export async function hasPendingBudgetResumeForRun(db: Db, runId: string) {
  const [row] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .where(and(eq(budgetResumeClaims.runId, runId), eq(budgetResumeClaims.state, "pending"))).limit(1);
  return Boolean(row);
}

/** True while a claim can be delivered now: its stop settled and no live
 * dispatcher holds it. A claim waiting for its Stop re-arms with that Stop. */
export async function hasDeliverableBudgetResume(db: Db, now = new Date()) {
  const [row] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, budgetResumeClaims.runId))
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(and(eq(budgetResumeClaims.state, "pending"),
      notInArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
      notInArray(agents.status, [...WAITING_AGENT_STATUSES]),
      or(isNull(budgetResumeClaims.claimedAt),
        lte(budgetResumeClaims.claimedAt, new Date(now.getTime() - BUDGET_RESUME_CLAIM_STALE_MS))))).limit(1);
  return Boolean(row);
}

/** When the earliest claimed, undelivered claim goes stale and becomes
 * deliverable again, so a worker can wake for it without another signal. */
export async function nextBudgetResumeClaimExpiryAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ at: sql<Date | null>`min(${budgetResumeClaims.claimedAt})` }).from(budgetResumeClaims)
    .where(and(eq(budgetResumeClaims.state, "pending"), sql`${budgetResumeClaims.claimedAt} is not null`));
  const claimedAt = row?.at ? new Date(row.at).getTime() : null;
  return claimedAt === null ? null : claimedAt + BUDGET_RESUME_CLAIM_STALE_MS;
}

type PendingRow = {
  id: string; companyId: string; agentId: string; agentStatus: string; status: string; createdAt: Date;
  issueId: string | null; stoppedByPerson: boolean; otherCancellation: boolean; claim: BudgetResumeClaim | null;
};

/**
 * Deliver every pending claim whose stop has settled. Pages through all
 * pending claims; a claim that waits (stop not settled, or a live
 * dispatcher's fresh claim) is skipped without a write.
 */
export async function deliverBudgetResumeContinuations(db: Db, delivery: BudgetResumeDelivery = {}, now = new Date()) {
  let after: string | null = null;
  for (;;) {
    const page = await db.select({
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      agentStatus: agents.status, status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt, issueId: runIssueId,
      incidentId: budgetResumeClaims.incidentId, actorUserId: budgetResumeClaims.actorUserId,
      actorSource: budgetResumeClaims.actorSource, claimedAt: budgetResumeClaims.claimedAt,
      stoppedByPerson: sql<boolean>`(coalesce(${heartbeatRuns.resultJson}->'cancellation'->'initiator'->>'type', '') = 'user'
        or coalesce(${heartbeatRuns.resultJson}->'cancellation'->>'source', '') = 'operator'
        or coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') in ('user', 'board'))`,
      // Claimed only for its admission stamp, but cancelled for another reason.
      otherCancellation: sql<boolean>`(${heartbeatRuns.resultJson} ? 'budgetAdmissionStop'
        and coalesce(${heartbeatRuns.resultJson}->'cancellation'->>'reason', '')
          <> coalesce(${heartbeatRuns.resultJson}->'budgetAdmissionStop'->>'reason', '')
        and not coalesce(${heartbeatRuns.resultJson}->'startupCancellation' ? 'budgetEnforcement', false)
        and not ${heartbeatRuns.resultJson} ? 'pauseStop')`,
    }).from(budgetResumeClaims).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, budgetResumeClaims.runId))
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(eq(budgetResumeClaims.state, "pending"), after ? gt(budgetResumeClaims.runId, after) : undefined))
      .orderBy(asc(budgetResumeClaims.runId)).limit(PAGE_SIZE);
    if (!page.length) return;
    after = page[page.length - 1]!.id;
    const rows: PendingRow[] = page.map(({ incidentId, actorUserId, actorSource, claimedAt, ...run }) =>
      ({ ...run, claim: { incidentId, actorUserId, actorSource, claimedAt } }));
    for (const run of rows) {
      // One task's failure must not stop the others. Its claim goes stale and
      // a later pass retries it.
      try { await deliverOne(db, delivery, now, run); }
      catch (error) { logger.warn({ err: error, runId: run.id }, "Budget resume continuation remains pending"); }
    }
    if (rows.length < PAGE_SIZE) return;
  }
}

/**
 * Settle a claim and record why, in one commit. A crash before it leaves the
 * claim pending; the Retry's idempotency key makes the next pass return the
 * same request, so the record is never lost or doubled.
 */
async function settle(db: Db, run: PendingRow, expectedClaimedAt: Date | null, outcome: {
  state: "delivered" | "abandoned"; reason?: string; requestId?: string | null;
}) {
  const claim = run.claim!;
  const publications: ActivityPublication[] = [];
  const settled = await db.transaction(async tx => {
    if (!await setClaim(tx, { runId: run.id, expectedClaimedAt,
      next: { state: outcome.state, settledAt: new Date(),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}) } })) return false;
    await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "user", actorId: claim.actorUserId,
      action: outcome.state === "delivered" ? "budget.cancelled_work_continued" : "budget.cancelled_work_not_continued",
      entityType: "issue", entityId: run.issueId!,
      details: { budgetIncidentId: claim.incidentId, interruptedRunId: run.id,
        ...(outcome.requestId ? { retryRequestId: outcome.requestId } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}) } }, publications);
    return true;
  });
  if (settled) for (const publication of publications) publishActivity(publication);
  return settled;
}

async function deliverOne(db: Db, delivery: BudgetResumeDelivery, now: Date, run: PendingRow) {
  const claim = run.claim;
  if (!claim || !run.issueId) return;
  // The stop is still being delivered; revisit once it settles.
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return;
  const claimedAt = claim.claimedAt ?? null;
  // A fresh claim belongs to a live dispatcher.
  if (claimedAt && now.getTime() - claimedAt.getTime() < BUDGET_RESUME_CLAIM_STALE_MS) return;
  // The run finished before its stop landed: nothing was cancelled.
  if (run.status !== "cancelled") { await settle(db, run, claimedAt, { state: "abandoned", reason: "run_not_cancelled" }); return; }
  // A person stopped the run after the resume claimed it: their Stop wins.
  if (run.stoppedByPerson) { await settle(db, run, claimedAt, { state: "abandoned", reason: "stopped_by_person" }); return; }
  if (run.otherCancellation) { await settle(db, run, claimedAt, { state: "abandoned", reason: "cancelled_for_another_reason" }); return; }
  // The resume is still lifting the agent's hold (a connected chat refuses a
  // Retry for a paused agent). Wait without claiming; the agent's status
  // change wakes delivery.
  // A stale claim is released first, so its expiry no longer schedules passes.
  if ((WAITING_AGENT_STATUSES as readonly string[]).includes(run.agentStatus)) {
    if (claimedAt) await setClaim(db, { runId: run.id, expectedClaimedAt: claimedAt, next: { claimedAt: null } });
    return;
  }
  const nextClaim = new Date(now.getTime());
  if (!await setClaim(db, { runId: run.id, expectedClaimedAt: claimedAt, next: { claimedAt: nextClaim } })) return;
  // The board member's own Retry: the path that clears a stopped task's
  // execution hold, and that accepts only while this run is still the task's
  // latest run and the task is open and assigned (checked under the task lock).
  const requestTaskRetry = delivery.requestRetry ?? (await import("./task-retry.js")).requestTaskRetry;
  let receipt: Awaited<ReturnType<typeof requestTaskRetry>>;
  try {
    receipt = await requestTaskRetry({ db, companyId: run.companyId, issueId: run.issueId,
      observedRunId: run.id, idempotencyKey: `budget-resume:${run.id}`, actorId: claim.actorUserId,
      ...(claim.actorSource ? { actorSource: claim.actorSource } : {}),
      ...(delivery.prepareChatRetry ? { prepareChatRetry: delivery.prepareChatRetry } : {}) });
  } catch (error) {
    // A refusal the Retry path names is permanent for this claim; record it.
    // Anything else (a database error) leaves the claim to go stale and retry.
    // A refusal the Retry path marks retryable (brief chat-authorization
    // contention) releases the claim for the next pass.
    if (error instanceof HttpError && (error.details as { retryable?: unknown } | undefined)?.retryable === true) {
      await setClaim(db, { runId: run.id, expectedClaimedAt: nextClaim, next: { claimedAt: null } });
      return;
    }
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      const code = (error.details as { code?: unknown } | undefined)?.code;
      await settle(db, run, nextClaim, { state: "abandoned",
        reason: typeof code === "string" ? code : `retry_refused_${error.status}` });
      return;
    }
    throw error;
  }
  if (!receipt.accepted) {
    await settle(db, run, nextClaim, { state: "abandoned", reason: "work_continued_or_task_changed" });
    return;
  }
  if (!await settle(db, run, nextClaim, { state: "delivered", requestId: receipt.requestId ?? null })) return;
  if (receipt.requestId && !receipt.chatActionId && delivery.resumeTaskRetry)
    await delivery.resumeTaskRetry(run.companyId, receipt.requestId).catch(error =>
      logger.warn({ err: error, runId: run.id }, "Budget resume Retry remains queued"));
}

/** Wake budget delivery when an agent becomes able to take work and a
 * resume claim waits on it. Runs inside the agent's status-change transaction. */
export async function notifyBudgetResumeAgentReady(tx: Db, agentId: string) {
  const [pending] = await tx.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, budgetResumeClaims.runId))
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(budgetResumeClaims.state, "pending"))).limit(1);
  if (pending) await notifyDeliveryWork(tx, DELIVERY_QUEUES.budgetEnforcement);
}

/** Wake the continuation worker after budget Stops land. */
export async function notifyBudgetStopsSettled(db: Db, runIds: string[]) {
  if (!runIds.length) return;
  const [pending] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims).where(and(
    inArray(budgetResumeClaims.runId, runIds), eq(budgetResumeClaims.state, "pending"))).limit(1);
  if (pending) await notifyDeliveryWork(db, DELIVERY_QUEUES.executionContinuation);
}
