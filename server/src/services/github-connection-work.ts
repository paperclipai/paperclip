import { logger } from "../middleware/logger.js";
import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { registerConnectionEventWake } from "./connection-event-wake.js";
import type { githubConnectionEventService } from "./github-connection-events.js";
import type { createGitHubGrantContinuity } from "./tool-access/github-grant-continuity.js";

type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;
export function registerGitHubConnectionEventWork(db: Db, coordinator: Coordinator,
  service: ReturnType<typeof githubConnectionEventService>, canRun: () => boolean) {
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.connectionEvents, {
    retryMs: 5_000, canRun,
    run: () => service.pollOnce({ forDelivery: true }),
    next: async () => service.nextPollAt(),
  });
  const stops = [registerConnectionEventWake(db, worker.wake),
    subscribeDeliveryWork(db, DELIVERY_QUEUES.toolConnectionHealth, worker.wake),
    subscribeDeliveryWork(db, DELIVERY_QUEUES.chatReceivers, worker.wake)];
  return { ...worker, stop: async () => { for (const stop of stops) stop(); await worker.stop(); } };
}
export function registerGitHubConnectionContinuityWork(db: Db, coordinator: Coordinator,
  service: Pick<ReturnType<typeof createGitHubGrantContinuity>, "sweepGitHubConnectionContinuity" | "nextGitHubConnectionContinuityAt">,
  canRun: () => boolean) {
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.connectionContinuity, {
    retryMs: 30_000, canRun,
    run: async () => {
      const result = await service.sweepGitHubConnectionContinuity();
      if (result.failed) logger.warn(result, "GitHub credential continuity retained retry obligations");
    },
    next: () => service.nextGitHubConnectionContinuityAt(),
  });
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.toolConnectionHealth, worker.wake);
  return { ...worker, stop: async () => { unsubscribe(); await worker.stop(); } };
}
