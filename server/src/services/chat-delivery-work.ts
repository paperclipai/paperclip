import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "./delivery-work-notifications.js";

type ChatDeliveryService = {
  processQueuedDeliveries(): Promise<unknown>;
  scheduleQueuedPublications(): Promise<unknown>;
  processPendingSlackFileUploadReceipts(): Promise<unknown>;
  nextInboundDeliveryAt(): Promise<number | null>;
  nextPublicationAt(): Promise<number | null>;
  nextSlackReceiptAt(): Promise<number | null>;
  onPublicationsSettled(wake: () => void): void;
};

/** Independent queue workers share the app's scheduler and DB transaction owner. */
export function registerChatDeliveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ChatDeliveryService,
  canRun: () => boolean,
) {
  const tasks = [
    { queue: DELIVERY_QUEUES.chatInbound, run: service.processQueuedDeliveries, next: service.nextInboundDeliveryAt },
    { queue: DELIVERY_QUEUES.chatPublications, run: service.scheduleQueuedPublications, next: service.nextPublicationAt },
    { queue: DELIVERY_QUEUES.chatReceipts, run: service.processPendingSlackFileUploadReceipts, next: service.nextSlackReceiptAt },
  ];
  const workers = tasks.map(task => {
    const worker = registerChatQueueWork(coordinator, task, canRun);
    if (task.queue === DELIVERY_QUEUES.chatPublications) {
      // Dispatch returns after reserving endpoint slots. Refill them when a
      // provider task ends, including failures before its final durable write.
      service.onPublicationsSettled(worker.wake);
    }
    return worker;
  });
  return { ready: Promise.all(workers.map(worker => worker.ready)) };
}

/** Empty queues disarm; only known work, uncertain writes, and failures retry. */
export function registerChatQueueWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  task: { queue: DeliveryQueue; run(): Promise<unknown>; next(): Promise<number | null> },
  canRun: () => boolean,
) {
  let next: number | null = null;
  const worker = coordinator.register(task.queue, {
    retryMs: 1000,
    run: () => task.run(),
    hasPending: async () => {
      next = canRun() ? await task.next() : Date.now() + 1000;
      return false;
    },
    nextRunAt: () => next === null ? null : Math.max(Date.now() + 1000, next),
  });
  return worker;
}
