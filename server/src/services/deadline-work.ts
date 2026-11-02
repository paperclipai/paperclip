import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { DeliveryQueue } from "./delivery-work-notifications.js";

export function registerDeadlineWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  queue: DeliveryQueue,
  task: {
    run: (signal: AbortSignal) => Promise<unknown>;
    next: () => Promise<number | null>;
    canRun: () => boolean;
    retryMs: number;
    onSettled?: (hints?: ReadonlySet<string>) => void;
    continuationMs?: number;
    // Optional batching latency for notifications; already-known deadlines still preempt it.
    notificationCoalesceMs?: number;

    minimumSpacingMs?: number;
  },
) {
  let requested = 1, reconciled = 0;
  let next: number | null = null;
  let earliest = 0;
  let coalesceUntil = 0;
  const worker = coordinator.register(queue, {
    retryMs: task.retryMs,
    pausePassiveMaintenance: true,
    onSettled: hints => { requested++; task.onSettled?.(hints); },
    run: async signal => {
      if (!task.canRun()) { requested++; return; }
      if (Date.now() < earliest) { next = earliest; return; }
      if (Date.now() < coalesceUntil && (next === null || next > Date.now())) {
        next = next === null ? coalesceUntil : Math.min(next, coalesceUntil);
        return;
      }
      const generation = ++requested;
      const startedAt = Date.now();
      earliest = startedAt + Math.max(task.retryMs, task.minimumSpacingMs ?? 0);
      await task.run(signal);
      if (signal.aborted || !task.canRun()) { next = null; return; }
      const deadline = await task.next();

      if (!task.canRun()) { next = null; return; }
      earliest = deadline === null || deadline > Date.now()
        ? (task.minimumSpacingMs ? Date.now() + task.minimumSpacingMs : 0)
        : startedAt + Math.max(task.continuationMs ?? task.retryMs, task.minimumSpacingMs ?? 0);
      next = deadline === null ? null : Math.max(earliest, deadline);
      coalesceUntil = Date.now() + (task.notificationCoalesceMs ?? 0);
      reconciled = generation;
    },
    // A settled producer must release its admission hold during drain. Keep
    // the unreconciled generation and an in-memory resume wake, without asking
    // the domain to probe its database while dispatch is closed.
    hasPending: async () => task.canRun() && requested !== reconciled,
    nextRunAt: () => !task.canRun() && requested !== reconciled
      ? Date.now() + task.retryMs
      : next,
  });
  return { ...worker, wake: () => { requested++; worker.wake(); } };
}
