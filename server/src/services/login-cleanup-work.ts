import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { LoginCleanupQueue } from "./login-cleanup-notifications.js";
import { LOGIN_CLEANUP_RETRY_MS } from "./login-cleanup-state.js";

export function registerLoginCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  duties: ReadonlyArray<{ queue: LoginCleanupQueue; run: () => Promise<unknown>; next: () => Promise<number | null> }>,
  canRun: () => boolean,
  retryMs = LOGIN_CLEANUP_RETRY_MS,
) {
  const workers = duties.map(duty => {
    let requested = 1;
    let reconciled = 0;
    let next: number | null = null;
    let earliestRunAt = 0;
    return coordinator.register(duty.queue, {
      retryMs,
      pausePassiveMaintenance: true,
      onSettled: () => { requested += 1; },
      run: async () => {
        if (!canRun()) { requested += 1; next = null; return; }
        const now = Date.now();
        if (now < earliestRunAt) {
          if (reconciled !== requested || (next !== null && next <= now)) next = earliestRunAt;
          return;
        }
        const generation = ++requested;
        earliestRunAt = now + retryMs;
        await duty.run();
        const deadline = await duty.next();
        next = deadline === null ? null : Math.max(deadline, earliestRunAt);
        reconciled = generation;
      },
      hasPending: async () => reconciled !== requested,
      nextRunAt: () => next,
    });
  });
  return { ready: Promise.all(workers.map(worker => worker.ready)) };
}
