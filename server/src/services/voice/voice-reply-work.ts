import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { voiceReplyMatches, type voiceReplySchedule } from "./voice-reply-schedule.js";
import { voiceReplyScope } from "./voice-reply-notifications.js";

export function registerVoiceReplyWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof voiceReplySchedule>,
  canRun: () => boolean,
) {
  service.reset();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.voiceReplies,
    decodeScope: voiceReplyScope,
    matches: voiceReplyMatches,
    load: (scope, signal) => service.load(scope, signal),
    check: (entry, signal) => service.check(entry, signal),
  }, canRun);
}
