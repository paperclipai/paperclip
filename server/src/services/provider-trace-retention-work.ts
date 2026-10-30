import type { Db } from "@paperclipai/db";
import { providerTraceStore } from "./provider-trace-store.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";

export function registerProviderTraceRetentionWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
) {
  const traces = providerTraceStore(db);
  let deadline: number | null | undefined;

  const unregister = registerIdleLocalWorkProbe(() =>
    deadline === undefined ? "unknown" : deadline === null ? "none" : "present",
  );
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.providerTraceRetention, {
    canRun,
    retryMs: 30_000,
    onSettled: () => {
      deadline = undefined;
    },
    run: (signal) =>
      signal.aborted ? Promise.resolve() : traces.cleanupExpired(new Date(), signal).then(() => undefined),
    next: async () => {
      deadline = await traces.nextRetentionDeadline();
      return deadline;
    },
  });
  return {
    ...worker,
    stop: async () => {
      unregister();
      await worker.stop();
    },
  };
}
