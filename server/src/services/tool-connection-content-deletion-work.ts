import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { getRunLogStore } from "./run-log-store.js";
import { createConnectionContentDeletion } from "./tool-access/connections/content-deletion.js";

export function registerToolConnectionContentDeletionWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
) {
  const deletions = createConnectionContentDeletion(db, { runLogStore: getRunLogStore });
  let deadline: number | null | undefined;
  const unregister = registerIdleLocalWorkProbe(() => {
    if (deadline === undefined) return "unknown";
    return deadline === null ? "none" : "present";
  });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.toolConnectionContentDeletion, {
    canRun,
    retryMs: 30_000,
    continuationMs: 250,
    onSettled: () => {
      deadline = undefined;
    },
    run: (signal) => signal.aborted ? Promise.resolve() : deletions.processPending(signal),
    next: async () => {
      deadline = await deletions.nextDeadline();
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
