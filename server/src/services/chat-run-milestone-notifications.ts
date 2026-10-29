import { notifyIssueReviewState } from "./issue-review-state-notifications.js";
import { notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { notifyChatResponseAvailability } from "./chat-response-availability.js";
import { notifyChatConfirmationWork } from "./chat-confirmation-notifications.js";
import { notifyChatInboundWakeNotices } from "./chat-inbound-wake-notice-notifications.js";
import { notifyChatNativeProgress } from "./chat-native-progress-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** Lineage changes can authorize descendants, so invalidate the issue rather
 * than just the run whose row changed. Configuration may invalidate a company. */
export type ChatRunMilestoneScope = { companyId: string; issueId?: string; runId?: string };

export async function notifyChatRunMilestones(tx: object, scope: ChatRunMilestoneScope) {
  if (scope.issueId || scope.runId) {
    await notifyIssueReviewState(tx, { companyId: scope.companyId, issueId: scope.issueId,
      runId: scope.issueId ? undefined : scope.runId });
    await notifyNativeResponsePresentation(tx, { companyId: scope.companyId, issueId: scope.issueId,
      runId: scope.issueId ? undefined : scope.runId });
  }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubReviewChecks, JSON.stringify({ companyId: scope.companyId }));
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubTerminalResponses, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatRunMilestones, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
  // Lifecycle and coarse native progress share lineage and authority. Extend
  // this eligibility boundary once rather than adding wrappers to its callers.
  await notifyChatNativeProgress(tx, scope);
  // Admission and current chat authority also govern saved queue notices.
  await notifyChatInboundWakeNotices(tx, scope, { notifySettlement: false });
  await notifyChatConfirmationWork(tx, scope);
  // Native presentation and run ownership can unblock a parked acknowledgement.
  await notifyChatResponseAvailability(tx, scope, { notifySettlement: false });
}

export async function notifyChatCompanyAuthorityChange(tx: object, scope: { companyId: string }) {
  await notifyChatRunMilestones(tx, scope);
  await notifyNativeResponsePresentation(tx, scope);
  await notifyIssueReviewState(tx, scope);
}
