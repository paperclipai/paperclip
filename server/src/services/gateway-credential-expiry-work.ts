import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";
import type { createToolGatewayService } from "./tool-gateway.js";

const GATEWAY_RUN_TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);

export function registerGatewayCredentialExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "cleanupExpiredSessions" | "nextCredentialExpiryAt">,
  canRun: () => boolean,
) {
  const work = registerDeadlineWork(coordinator, DELIVERY_QUEUES.gatewayCredentialExpiry, {
    retryMs: 30_000,
    notificationCoalesceMs: 30_000,
    canRun,
    run: () => gateway.cleanupExpiredSessions({ singleBatch: true }),
    next: () => gateway.nextCredentialExpiryAt(),
  });
  // A token whose bound run just ended becomes deletable immediately; the next
  // credential deadline may be far out, so terminal run events wake the worker
  // instead of leaving the row until unrelated expiry work.
  const unsubscribe = subscribeAllCompanyLiveEvents(event => {
    if (event.type !== "heartbeat.run.status") return;
    if (GATEWAY_RUN_TERMINAL_STATUSES.has(String(event.payload.status))) work.wake();
  });
  return { ...work, stop: async () => { unsubscribe(); await work.stop(); } };
}
