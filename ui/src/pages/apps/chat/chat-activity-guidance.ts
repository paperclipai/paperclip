import type { ChatActivityItem } from "@paperclipai/shared";
import { t } from "@/i18n";

// Only these action kinds author their own guidance in listActivity.
// Delivery/publication details are provider diagnostics and must remain verbatim.
const actionGuidance: Record<string, Record<string, string>> = {
  "slash_task_start": {
    "Slack may have accepted the task-start message, so Paperclip will not replay it automatically. Check Slack first; an explicit retry can create a duplicate starter message and task.": "chatActivity.guidance.slashUnconfirmedRetry",
    "Slack may have accepted the task-start message. This older action lacks the context required for a safe explicit retry, so check Slack and cancel it here before submitting a new command.": "chatActivity.guidance.slashUnconfirmedLegacy",
    "Slack accepted the task-start message. Paperclip is completing durable task admission without sending another Slack message.": "chatActivity.guidance.slashConfirmed",
    "Slack accepted the task-start message. A Paperclip worker is admitting the task without replaying the Slack send.": "chatActivity.guidance.slashAdmitting",
    "Slack rejected the task-start message. Submit the command again to retry.": "chatActivity.guidance.slashRejected",
    "An operator cancelled this unconfirmed task start.": "chatActivity.guidance.slashCancelled"
  },
  "provider_effect": {
    "The provider may have accepted this reply, but Paperclip could not confirm it or close the task conversation. Check the provider first. Marking it delivered closes the conversation; retrying can create a duplicate message.": "chatActivity.guidance.replyUnconfirmedClose",
    "The provider may have accepted this reply, but Paperclip could not confirm it. Check the provider first. Retrying can create a duplicate message.": "chatActivity.guidance.replyUnconfirmed"
  },
  "slack_session_sync": {
    "Slack has not enabled native session status for this destination. Message delivery continues.": "chatActivity.guidance.sessionUnavailable",
    "Slack rejected the session indicator update. Check app permissions and channel access; message delivery is tracked separately.": "chatActivity.guidance.sessionRejected",
    "The Slack session indicator is waiting to sync. Paperclip will not resend the response.": "chatActivity.guidance.sessionWaiting",
    "Working status is refreshed automatically while the run remains active.": "chatActivity.guidance.sessionWorking"
  },
  "slack_session_stop": {
    "Paperclip stopped the work authorized by this request.": "chatActivity.guidance.stopProcessed",
    "No work was stopped: this request was no longer authorized or its target was no longer current.": "chatActivity.guidance.stopCancelled",
    "The Stop request could not finish yet. Paperclip will retry against the original work only.": "chatActivity.guidance.stopRetry",
    "The Stop request could not be completed. Check the task's current run before trying again.": "chatActivity.guidance.stopFailed",
    "Paperclip is processing this Stop request against its original task and run.": "chatActivity.guidance.stopProcessing"
  },
  "github_webhook_ingress": {
    "An authenticated GitHub webhook could not be processed. Fix the connection or destination, then redeliver it from the GitHub App's Recent Deliveries page.": "chatActivity.guidance.githubIngress"
  }
};
const repairGuidance: Record<string, string> = {
  "The original comment changed or is no longer available. Paperclip did not replay its old contents.": "chatActivity.guidance.recoverySourceChanged",
  "This callback was not an eligible current user comment. Paperclip did not replay it.": "chatActivity.guidance.recoveryIneligible",
  "Paperclip received this callback. Its normal access checks and processing still apply.": "chatActivity.guidance.recoveryReceived",
  "Paperclip asked GitHub to resend a recent missed message. This does not yet confirm receipt or a reply. Automatic requests are limited; if it remains unanswered, check the App's Recent Deliveries and send your request again in the current conversation.": "chatActivity.guidance.recoveryRequested"
};
const healthGuidance: Record<string, string> = {
  "Recent webhook volume exceeded automatic recovery's bounded scan. No partial history was replayed. Check the App's Recent Deliveries for missed messages.": "chatActivity.guidance.recoveryHistoryLimit",
  "The GitHub App's callback no longer matches this connection. Reconnect the App to repair it; repository access will not change.": "chatActivity.guidance.recoveryCallbackMismatch",
  "Paperclip could not check GitHub's failed deliveries. The check will retry with backoff; normal callbacks are still processed.": "chatActivity.guidance.recoveryScanFailed"
};

const githubDeliveryPrefix = "GitHub delivery ";
const githubDeliverySuffix = " was authenticated, but Paperclip could not finish processing it. Fix the connection or destination, then redeliver this delivery from the GitHub App's Recent Deliveries page.";

/** Exact first-party guidance matching; never rewrites provider/user diagnostics. */
export function chatActivityDetail(item: ChatActivityItem): string | null | undefined {
  if (!item.detail) return item.detail;
  const known = item.kind === "repair"
    ? repairGuidance
    : item.kind === "health"
      ? healthGuidance
      : item.kind === "action" && item.actionType && Object.hasOwn(actionGuidance, item.actionType)
        ? actionGuidance[item.actionType]
        : undefined;
  if (known && Object.hasOwn(known, item.detail)) return t(known[item.detail]);
  if (
    item.kind === "action" &&
    item.actionType === "github_webhook_ingress" &&
    item.detail.startsWith(githubDeliveryPrefix) &&
    item.detail.endsWith(githubDeliverySuffix)
  ) {
    const deliveryId = item.detail.slice(githubDeliveryPrefix.length, -githubDeliverySuffix.length);
    if (deliveryId) return t("chatActivity.guidance.githubIngressDelivery", { deliveryId });
  }
  return item.detail;
}
