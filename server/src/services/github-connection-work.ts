import { logger } from "../middleware/logger.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerConnectionEventWake } from "./connection-event-wake.js";
import type { githubConnectionEventService } from "./github-connection-events.js";
import type { createGitHubGrantContinuity } from "./tool-access/github-grant-continuity.js";

type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;
export function registerGitHubConnectionEventWork(db: Db, coordinator: Coordinator,
  service: ReturnType<typeof githubConnectionEventService>, canRun: () => boolean) {
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.connectionEvents, {
    retryMs: 5_000, minimumSpacingMs: 5_000, notificationCoalesceMs: 1_000, canRun,
    run: () => service.pollOnce({ forDelivery: true }),
    next: async () => service.nextPollAt(),
  });
  const stops = [registerConnectionEventWake(db, worker.wake)];
  return { ...worker, stop: async () => { for (const stop of stops) stop(); await worker.stop(); } };
}
export function registerGitHubConnectionContinuityWork(db: Db, coordinator: Coordinator,
  service: Pick<ReturnType<typeof createGitHubGrantContinuity>, "sweepGitHubConnectionContinuity" | "nextGitHubConnectionContinuityAt" | "githubConnectionContinuitySchedule">,
  canRun: () => boolean) {
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.connectionContinuity,
    minimumPassIntervalMs: 5_000,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => !companyId || entry.companyId === companyId,
    load: companyId => service.githubConnectionContinuitySchedule(companyId),
    check: async entry => {
      const result = await service.sweepGitHubConnectionContinuity(entry.companyId);
      if (result.failed) logger.warn(result, "GitHub credential continuity retained retry obligations");
      const dueAt = await service.nextGitHubConnectionContinuityAt(entry.companyId);
      return dueAt === null ? null : { ...entry, dueAt };
    },
  }, canRun);
  return worker;
}
