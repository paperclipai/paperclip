import type { RunDispatchScope } from "../run-dispatch-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerDeadlineWork } from "../deadline-work.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { createQueuedRunRedriveSchedule, type UndispatchedQueuedRun } from "../queued-run-dispatch-liveness.js";

export function registerRunDispatchWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    promoteDueScheduledRetries(): Promise<unknown>;
    nextScheduledRetryAt(): Promise<number | null>;
    resumeQueuedRunsAfterDrain(scope?: RunDispatchScope): Promise<unknown>;
    listUndispatchedQueuedRuns?(): Promise<UndispatchedQueuedRun[]>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  let suppressed = false;
  const retries = registerDeadlineWork(coordinator, DELIVERY_QUEUES.scheduledRetryDispatch, {
    retryMs: 30_000,
    continuationMs: 1_000,
    notificationCoalesceMs: 1_000,
    canRun,
    run: async signal => {
      suppressed = await owner.schedulingSuppressed();
      if (!signal.aborted && !suppressed && canRun()) await owner.promoteDueScheduledRetries();
    },
    next: () => suppressed ? Promise.resolve(null) : owner.nextScheduledRetryAt(),
  });
  const scopes = new Set<string>(["*"]);
  const redrive = createQueuedRunRedriveSchedule();
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
    next: async () => {
      if (!owner.listUndispatchedQueuedRuns || await owner.schedulingSuppressed()) return null;
      const plan = redrive.plan(await owner.listUndispatchedQueuedRuns());
      for (const companyId of plan.companyIds) scopes.add(JSON.stringify({ companyId }));
      return plan.nextAt;
    },
  });
  return {
    retries,
    ready: Promise.all([retries.ready, queue.ready]),
    wake() { scopes.add("*"); retries.wake(); queue.wake(); },
    async stop() { await Promise.all([retries.stop(), queue.stop()]); },
  };
}
