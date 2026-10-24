import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { DeliveryQueue } from "./delivery-work-notifications.js";

export function registerDeadlineWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  queue: DeliveryQueue,
  task: {
    run: () => Promise<unknown>;
    next: () => Promise<number | null>;
    canRun: () => boolean;
    retryMs: number;
  },
) {
  let requested = 1, reconciled = 0;
  let next: number | null = null;
  let earliest = 0;
  return coordinator.register(queue, {
    retryMs: task.retryMs,
    pausePassiveMaintenance: true,
    onSettled: () => { requested++; },
    run: async () => {
      if (!task.canRun()) { requested++; return; }
      if (Date.now() < earliest) { next = earliest; return; }
      const generation = ++requested;
      earliest = Date.now() + task.retryMs;
      await task.run();
      const deadline = await task.next();
      next = deadline === null ? null : Math.max(earliest, deadline);
      reconciled = generation;
    },
    hasPending: async () => requested !== reconciled,
    nextRunAt: () => next,
  });
}
