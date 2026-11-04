import type { Db } from "@paperclipai/db";
import { withBudgetSpan } from "./budget-tracing.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import {
  deliverBudgetEnforcement,
  hasPendingBudgetEnforcement,
  nextBudgetReconciliationAt,
  reconcileDueBudgetPolicies,
  type BudgetServiceHooks,
} from "./budgets.js";
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
  let reconciling = false;
  let nextDeadline: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.budgetEnforcement, {
    retryMs: 1_000,
    runDuringDrain: true,
    async run(signal) {
      if (signal.aborted) return;
      if (startup || reconciling || (nextDeadline !== null && nextDeadline <= Date.now())) {
        const page = await reconcileDueBudgetPolicies(db, { startup, ...(reconciliationCursor ? { cursor: reconciliationCursor } : {}) });
        reconciliationCursor = page.nextCursor;
        reconciling = reconciliationCursor !== null;
        if (!reconciling) startup = false;
      }
      if (signal.aborted) return;
      await withBudgetSpan("budget.enforcement.deliver", () => deliverBudgetEnforcement(db, hooks));
    },
    async hasPending() {
      const [pending, next] = await Promise.all([
        hasPendingBudgetEnforcement(db), nextBudgetReconciliationAt(db),
      ]);
      nextDeadline = next?.getTime() ?? null;
      return pending || reconciling;
    },
    nextRunAt: () => nextDeadline,
  });
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
  const stop = () => {
    unsubscribe();
    if (accountingWakes.get(db) === worker.wake) accountingWakes.delete(db);
  };
  return { ...worker, stop };
}
