import type { Db } from "@paperclipai/db";
import { ENVIRONMENT_CLEANUP_RETRY_MS, nextEnvironmentCleanupAt } from "./environment-cleanup-state.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "./delivery-work-notifications.js";
import { subscribeDeferredEnvironmentCleanup } from "./environment-cleanup-notifications.js";

export function registerEnvironmentCleanupWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  input: {
    sweepPending: (backoffMs: number) => Promise<unknown>;
    historical?: { sweep: () => Promise<unknown>; hasPending: () => Promise<boolean> };
    canRun: () => boolean;
    minimumSpacingMs?: number;
  },
) {
  const spacing = input.minimumSpacingMs ?? 30_000;
  function register(queue: DeliveryQueue, run: () => Promise<unknown>, deadline: () => Promise<number | null>, minimumSpacing = spacing) {
    let requested = 1, reconciled = 0, next: number | null = null, earliest = 0;
    const worker = coordinator.register(queue, {
      retryMs: spacing, pausePassiveMaintenance: true,
      onSettled: () => { requested++; },
      run: async () => {
        if (!input.canRun()) { requested++; next = null; return; }
        if (Date.now() < earliest) { next = earliest; return; }
        const generation = ++requested;
        earliest = Date.now() + minimumSpacing;
        await run();
        const due = await deadline();
        next = due === null ? null : Math.max(due, earliest);
        reconciled = generation;
      },
      hasPending: async () => requested !== reconciled,
      nextRunAt: () => next,
    });
    return { ready: worker.ready, wake: () => { requested++; worker.wake(); } };
  }
  let initial = true;
  const pending = register(DELIVERY_QUEUES.environmentCleanup, async () => {
    await input.sweepPending(initial ? 0 : ENVIRONMENT_CLEANUP_RETRY_MS);
    initial = false;
  }, () => nextEnvironmentCleanupAt(db));
  const unsubscribe = subscribeDeferredEnvironmentCleanup(db, pending.wake);
  const historical = input.historical;
  if (historical) register(DELIVERY_QUEUES.historicalCleanup, historical.sweep,
    async () => await historical.hasPending() ? Date.now() + ENVIRONMENT_CLEANUP_RETRY_MS : null,
    Math.max(spacing, ENVIRONMENT_CLEANUP_RETRY_MS));
  // The coordinator tracks and joins historical work; provider checks must not
  // delay server readiness or starting the heartbeat scheduler.
  return { ready: pending.ready, stop: unsubscribe };
}
