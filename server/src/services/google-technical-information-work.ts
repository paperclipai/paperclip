import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { createGoogleTechnicalInformationRetention } from "./tool-access/connections/google-technical-information.js";

export function registerGoogleTechnicalInformationWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
) {
  const retention = createGoogleTechnicalInformationRetention(db);
  let deadline: number | null | undefined;
  const unregister = registerIdleLocalWorkProbe((options = {}) => {
    if (deadline === undefined) return "unknown";
    if (deadline === null) return "none";
    return options.deadlineCapability?.deadlineCatalog === "domain_deadlines_v1" && deadline > Date.now()
      ? "none" : "present";
  });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.googleTechnicalInformation, {
    canRun,
    retryMs: 60_000,
    notificationCoalesceMs: 5_000,
    onSettled: () => {
      deadline = undefined;
    },
    run: (signal) => signal.aborted ? Promise.resolve() : retention.sweep(signal),
    next: async () => {
      deadline = await retention.nextDeadline();
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
