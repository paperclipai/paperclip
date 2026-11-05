import type { RunDispatchScope } from "../run-dispatch-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerDeadlineWork } from "../deadline-work.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { QUOTA_RECOVERY_RETRY_REASON } from "../../modules/run-dispatch/index.js";

/** How long a sweep that ran degraded waits before it re-reads in-flight state. */
const DEGRADED_SWEEP_BACKOFF_MS = 30_000;

export function registerRunDispatchWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    promoteDueScheduledRetries(): Promise<{ degraded?: boolean } | void>;
    nextScheduledRetryAt(input?: { excludeReason?: string }): Promise<number | null>;
    resumeQueuedRunsAfterDrain(scope?: RunDispatchScope): Promise<unknown>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  let suppressed = false;
  // A degraded sweep denies quota-recovery releases without rescheduling the
  // rows, so their due time stays in the past on purpose. `next()` would then
  // return an instant that has already passed, and the deadline work treats a
  // past deadline as a 1s continuation: the sweep would re-read the in-flight
  // count that just failed, once per second, forever. One recovery window of
  // backoff replaces that spin without touching the parked rows.
  let degradedBackoffUntil = 0;
  const retries = registerDeadlineWork(coordinator, DELIVERY_QUEUES.scheduledRetryDispatch, {
    retryMs: 30_000,
    continuationMs: 1_000,
    notificationCoalesceMs: 1_000,
    canRun,
    run: async signal => {
      suppressed = await owner.schedulingSuppressed();
      if (!signal.aborted && !suppressed && canRun()) {
        const sweep = await owner.promoteDueScheduledRetries();
        degradedBackoffUntil = sweep?.degraded ? Date.now() + DEGRADED_SWEEP_BACKOFF_MS : 0;
      }
    },
    next: async () => {
      if (suppressed) return null;
      const next = await owner.nextScheduledRetryAt();
      if (next === null || degradedBackoffUntil === 0) return next;
      // The floor belongs to the parked quota-recovery rows alone: their due
      // time stays in the past on purpose while the in-flight count is
      // unreadable, and they are the only rows the degraded sweep denied. A
      // retry scheduled for another reason is due on its own schedule, so read
      // that class separately and keep whichever deadline is earlier.
      const floored = Math.max(next, degradedBackoffUntil);
      const other = await owner.nextScheduledRetryAt({ excludeReason: QUOTA_RECOVERY_RETRY_REASON });
      return other === null ? floored : Math.min(other, floored);
    },
  });
  const scopes = new Set<string>(["*"]);
  const queue = registerDeadlineWork(coordinator, DELIVERY_QUEUES.queuedRunDispatch, {
    retryMs: 30_000,
    notificationCoalesceMs: 1_000,
    canRun,
    onSettled: hints => { for (const hint of hints ?? ["*"]) scopes.add(hint); },
    run: async signal => {
      const requested = scopes.has("*") ? ["*"] : [...scopes];
      if (requested[0] === "*") scopes.clear();
      else for (const hint of requested) scopes.delete(hint);
      for (let index = 0; index < requested.length; index++) {
        if (signal.aborted || !canRun()) {
          for (const hint of requested.slice(index)) scopes.add(hint);
          return;
        }
        try {
          await owner.resumeQueuedRunsAfterDrain(requested[index] === "*" ? undefined : JSON.parse(requested[index]) as RunDispatchScope);
        } catch (error) {
          for (const hint of requested.slice(index)) scopes.add(hint);
          throw error;
        }
      }
    },
    next: async () => null,
  });
  return {
    ready: Promise.all([retries.ready, queue.ready]),
    wake() { scopes.add("*"); retries.wake(); queue.wake(); },
    async stop() { await Promise.all([retries.stop(), queue.stop()]); },
  };
}
