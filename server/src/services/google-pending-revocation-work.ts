import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, type PaperclipCloudConnector } from "./paperclip-cloud-connector.js";
import { createGooglePendingRevocation } from "./tool-access/connections/google-pending-revocation.js";

export function registerGooglePendingRevocationWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
  options: { currentCloudConnector?: () => PaperclipCloudConnector | null } = {},
) {
  let cached: PaperclipCloudConnector | null = null;
  const currentCloudConnector = options.currentCloudConnector ?? (() => {
    if (cached) return cached;
    const config = paperclipCloudConnectorConfigFromEnv();
    cached = config ? createPaperclipCloudConnector({ config }) : null;
    return cached;
  });
  const revocations = createGooglePendingRevocation(db, { currentCloudConnector });
  let deadline: number | null | undefined;
  const unregister = registerIdleLocalWorkProbe(() => {
    if (deadline === undefined) return "unknown";
    return deadline === null ? "none" : "present";
  });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.googlePendingRevocation, {
    canRun,
    retryMs: 30_000,
    continuationMs: 250,
    onSettled: () => {
      deadline = undefined;
    },
    run: (signal) => signal.aborted ? Promise.resolve() : revocations.drain(signal),
    next: async () => {
      deadline = await revocations.nextDeadline();
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
