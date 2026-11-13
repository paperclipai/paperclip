import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { withBudgetSpan } from "./budget-tracing.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import {
  deliverBudgetEnforcement,
  hasPendingBudgetEnforcement,
  nextBudgetReconciliationAt,
  reconcileDueBudgetPolicies,
  flushBudgetEvaluationWorkPage,
  type BudgetServiceHooks,
} from "./budgets.js";
import { hasPendingBudgetEvaluation } from "./budget-evaluation-work.js";
import { hasDeliverableBudgetResume, hasPendingBudgetResumeForRun, nextBudgetResumeClaimExpiryAt } from "./budget-resume-continuation.js";
import { readCostAccountingWork } from "./run-cost-accounting.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";

type Coordinator = Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">;
const accountingWakes = new WeakMap<Db, () => void>();

/** A durable filesystem receipt can need recovery even when its database
 * attempt failed before a transaction identity existed. Startup also replays it. */
export function wakeCostAccountingWork(db: Db): void {
  accountingWakes.get(db)?.();
}

/** The version pair is durable cancellation intent. Signals only request an
 * inspection; startup and concrete deadlines recover work after interruption. */
export function registerBudgetEnforcementWork(db: Db, coordinator: Coordinator, hooks: BudgetServiceHooks) {
  let startup = true;
  let reconciliationCursor: string | null = null;
  let evaluationCursor: string | null = null;
  let reconciling = false;
  let reconciliationFailed = false;
  let nextDeadline: number | null = null;
  let resumeClaimDeadline: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.budgetEnforcement, {
    retryMs: 1_000,
    coalesceMs: 1_000,
    runDuringDrain: true,
    async run(signal) {
      if (signal.aborted) return;
      if (startup || reconciling || (nextDeadline !== null && nextDeadline <= Date.now())) {
        const page = await reconcileDueBudgetPolicies(db, { startup, ...(reconciliationCursor ? { cursor: reconciliationCursor } : {}) });
        reconciliationCursor = page.nextCursor;
        reconciliationFailed ||= Boolean(page.hadFailures);
        reconciling = reconciliationCursor !== null;
        if (!reconciling) { startup = reconciliationFailed; reconciliationFailed = false; }
      }
      if (signal.aborted) return;
      const evaluation = await flushBudgetEvaluationWorkPage(db, { ...(evaluationCursor ? { cursor: evaluationCursor } : {}) });
      evaluationCursor = evaluation.nextCursor;
      if (signal.aborted) return;
      await withBudgetSpan("budget.enforcement.deliver", () => deliverBudgetEnforcement(db, hooks));
      if (signal.aborted) return;
      // Claims a resume saved, including runs whose Stop this pass just landed.
      // Registered with the always-on budget worker, not scheduled agent work.
      await hooks.deliverResumeContinuations?.().catch(error =>
        logger.warn({ err: error }, "Budget resume continuations remain pending"));
    },
    async hasPending() {
      const [pending, next, evaluation, resume, claimExpiry] = await Promise.all([
        hasPendingBudgetEnforcement(db), nextBudgetReconciliationAt(db), hasPendingBudgetEvaluation(db),
        // A deliverable resume claim (for example after a retryable refusal or
        // a database error) keeps this worker on its retry schedule.
        hooks.deliverResumeContinuations ? hasDeliverableBudgetResume(db) : Promise.resolve(false),
        // A claim held by a dispatcher that failed becomes deliverable when it
        // goes stale; wake for that moment without another budget signal.
        hooks.deliverResumeContinuations ? nextBudgetResumeClaimExpiryAt(db) : Promise.resolve(null),
      ]);
      nextDeadline = next?.getTime() ?? null;
      resumeClaimDeadline = claimExpiry ?? null;
      return pending || evaluation || resume || reconciling || startup || evaluationCursor !== null;
    },
    nextRunAt: () => nextDeadline === null ? resumeClaimDeadline
      : resumeClaimDeadline === null ? nextDeadline : Math.min(nextDeadline, resumeClaimDeadline),
  });
  if (!hooks.deliverResumeContinuations) return worker;
  // A Stop that settles later (a pause's lifecycle Stop, a delivered budget
  // Stop) makes a pending resume claim deliverable. The terminal status event
  // is published after its persisted transition; wake for it, so delivery
  // never waits for unrelated budget work.
  // Only a run that carries a pending resume claim wakes the worker: one
  // primary-key lookup, so other cancellations never start an instance pass.
  const unsubscribe = subscribeAllCompanyLiveEvents(event => {
    if (event.type !== "heartbeat.run.status" || String(event.payload.status) !== "cancelled") return;
    const runId = event.payload.runId;
    if (typeof runId !== "string") return;
    void hasPendingBudgetResumeForRun(db, runId).then(pending => { if (pending) worker.wake(); })
      .catch(error => logger.warn({ err: error, runId }, "Budget resume wake check failed"));
  });
  return { ...worker, stop: async () => { unsubscribe(); await worker.stop(); } };
}

/** Accounting repairs admitted work and never dispatches another paid turn.
 * A waiting partial receipt stays held without polling unchanged debt. */
export function registerCostAccountingWork(db: Db, coordinator: Coordinator, reconcile: () => Promise<unknown>) {
  let nextDeadline: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.accounting, {
    retryMs: 5_000,
    runDuringDrain: true,
    async run(signal) {
      if (signal.aborted) return;
      await withBudgetSpan("budget.accounting.recover", reconcile);
    },
    async hasPending() {
      const work = await readCostAccountingWork(db);
      nextDeadline = work.nextRunAt;
      return work.pending;
    },
    nextRunAt: () => nextDeadline,
  });
  accountingWakes.set(db, worker.wake);
  // The existing heartbeat terminal event is published after its persisted
  // transition. Receipt writes have transaction-aware accounting signals too.
  const unsubscribe = subscribeAllCompanyLiveEvents(event => {
    if (event.type === "heartbeat.run.status" &&
        ["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(String(event.payload.status))) worker.wake();
  });
  // A released or stopped sandbox can close a terminal run's lost receipt.
  // Those lease writers signal environment or retained-session cleanup.
  const unsubscribeLeases = [DELIVERY_QUEUES.environmentCleanup, DELIVERY_QUEUES.retainedNativeSessionCleanup]
    .map(queue => subscribeDeliveryWork(db, queue, worker.wake));
  const stop = () => {
    unsubscribe();
    for (const unsubscribeLease of unsubscribeLeases) unsubscribeLease();
    if (accountingWakes.get(db) === worker.wake) accountingWakes.delete(db);
  };
  return { ...worker, stop };
}
