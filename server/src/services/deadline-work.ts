import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { DeliveryQueue } from "./delivery-work-notifications.js";

export function registerDeadlineWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  queue: DeliveryQueue,
  task: {
    run: (signal: AbortSignal) => Promise<unknown>;
    next: () => Promise<number | null>;
    canRun: () => boolean;
    retryMs: number;
    continuationMs?: number;
    // Optional batching latency for notifications; already-known deadlines still preempt it.
    notificationCoalesceMs?: number;
  },
) {
  let requested = 1, reconciled = 0;
  let next: number | null = null;
  let earliest = 0;
  let coalesceUntil = 0;
  return coordinator.register(queue, {
    retryMs: task.retryMs,
    pausePassiveMaintenance: true,
    onSettled: () => { requested++; },
    run: async signal => {
      if (!task.canRun()) { requested++; return; }
      if (Date.now() < earliest) { next = earliest; return; }
      if (Date.now() < coalesceUntil && (next === null || next > Date.now())) {
        next = next === null ? coalesceUntil : Math.min(next, coalesceUntil);
        return;
      }
      const generation = ++requested;
      const startedAt = Date.now();
      earliest = startedAt + task.retryMs;
      await task.run(signal);
      if (signal.aborted) return;
      const deadline = await task.next();
      // Back off failed or still-overdue work, not a successfully read future deadline.
      earliest = deadline === null || deadline > Date.now()
        ? 0 : startedAt + (task.continuationMs ?? task.retryMs);
      next = deadline === null ? null : Math.max(earliest, deadline);
      coalesceUntil = Date.now() + (task.notificationCoalesceMs ?? 0);
      reconciled = generation;
    },
    hasPending: async () => requested !== reconciled,
    nextRunAt: () => next,
  });
}
