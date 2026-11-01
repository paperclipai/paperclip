import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { VoiceRecoveryEntry, voiceSessionRecovery } from "./voice-session-recovery.js";
import { voiceRecoveryScope, type VoiceRecoveryScope } from "./voice-recovery-notifications.js";

function matches(entry: VoiceRecoveryEntry, scope?: VoiceRecoveryScope) {
  return !scope || (scope.kind === "session" ? entry.id : scope.kind === "endpoint" ? entry.endpointId : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id;
}
export function registerVoiceRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof voiceSessionRecovery>,
  canRun: () => boolean,
) {
  service.reset();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.voiceSessionRecovery,
    decodeScope: voiceRecoveryScope,
    matches,
    load: (scope, signal) => service.refresh(scope, signal),
    check: (entry, signal) => service.check(entry.id, signal),
  }, canRun);
}
