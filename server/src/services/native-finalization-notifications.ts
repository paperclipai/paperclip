import { notifyNativeEnvironmentSettlement } from "./native-environment-settlement-notifications.js";
import { notifyExternalAgentSettlement } from "../modules/external-agents/index.js";
import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { notifyNativeRecoveryNotices } from "./native-recovery-notice-notifications.js";
import { notifyNativeRunProjection } from "./native-run-projection-notifications.js";
import { notifyNativeResultCommit } from "./native-result-commit-notifications.js";
import { notifyNativeWorkspaceFinalization } from "./native-workspace-finalization-notifications.js";
import { notifyRetainedNativeSessionCleanup } from "./retained-native-session-cleanup-notifications.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeFinalizationWorkScope = { companyId: string; runId?: string; issueId?: string };

export async function notifyNativeFinalizationWork(transaction: object, scope: NativeFinalizationWorkScope) {
  if (scope.issueId || scope.runId) {
    await notifyNativeEnvironmentSettlement(transaction, scope);
    await notifyExternalAgentSettlement(transaction, scope);
    await notifyExternalConversationSettlement(transaction, scope);
    await notifyNativeRecoveryNotices(transaction, scope);
    await notifyNativeRunProjection(transaction, scope);
    await notifyNativeResultCommit(transaction, scope);
    await notifyNativeWorkspaceFinalization(transaction, scope);
    await notifyRetainedNativeSessionCleanup(transaction, scope);
    await notifyNativeStatusReassessment(transaction, scope);
    await notifyNativeResponsePresentation(transaction, scope);
    await notifyNativeReviewResponse(transaction, scope);
  }
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.nativePendingEffects,
    JSON.stringify({ companyId: scope.companyId, runId: scope.runId }));
}
