import { notifyChatNativeProgress } from "./chat-native-progress-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** Lineage changes can authorize descendants, so invalidate the issue rather
 * than just the run whose row changed. Configuration may invalidate a company. */
export type ChatRunMilestoneScope = { companyId: string; issueId?: string };

export async function notifyChatRunMilestones(tx: object, scope: ChatRunMilestoneScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatRunMilestones, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
  // Lifecycle and coarse native progress share lineage and authority. Extend
  // this eligibility boundary once rather than adding wrappers to its callers.
  await notifyChatNativeProgress(tx, scope);
}
