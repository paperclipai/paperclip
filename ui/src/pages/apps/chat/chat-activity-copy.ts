import { CHAT_DELIVERY_STATES, CHAT_EVENT_KINDS, type ChatActivityItem } from "@paperclipai/shared";
import { t } from "@/i18n";
import { formatNumber } from "@/lib/utils";

const publicationSummaries: Record<string, string> = {
  "Interactive question": "question",
  "Response to external conversation": "response",
  "queued update": "queued",
  "working update": "working",
  "waiting for input update": "waiting_for_input",
  "approval needed update": "approval_needed",
  "completed update": "completed",
  "failed update": "failed",
};
const actionSummaries: Record<string, readonly [string, string]> = {
  provider_effect: ["Provider reply delivery unknown", "providerReplyUnknown"],
  slack_session_sync: ["Slack session status", "slackSessionStatus"],
  slack_session_stop: ["Slack Stop request", "slackStopRequest"],
  github_webhook_ingress: ["GitHub webhook could not be processed", "githubWebhookFailed"],
};
const repairSummaries: Record<string, string> = {
  "GitHub webhook recovery skipped": "githubRecoverySkipped",
  "GitHub webhook received after recovery request": "githubReceivedAfterRecovery",
  "GitHub webhook redelivery requested": "githubRedeliveryRequested",
};
const slashTaskStatuses = new Set([
  "queued", "validating", "received", "resolving", "delivery_unknown",
  "provider_confirmed", "admitting", "processed", "failed", "cancelled",
]);

/** Match only the closed first-party summaries produced by listActivity.
 * User/provider diagnostics and future summaries are intentionally unchanged. */
export function chatActivitySummary(item: ChatActivityItem): string {
  if (item.kind === "publication" && Object.hasOwn(publicationSummaries, item.summary)) {
    return t(`chatActivity.publication.${publicationSummaries[item.summary]}`);
  }
  if (item.kind === "action") {
    const known = item.actionType && Object.hasOwn(actionSummaries, item.actionType)
      ? actionSummaries[item.actionType]
      : undefined;
    if (known && item.summary === known[0]) return t(`chatActivity.${known[1]}`);
    if (item.actionType === "slash_task_start" && slashTaskStatuses.has(item.status) && item.summary === `Slack slash-command task start ${item.status.replaceAll("_", " ")}`) {
      return t("chatActivity.slackTaskStart", { status: t(`status.${item.status}`, { defaultValue: item.status }) });
    }
  }
  if (item.kind === "repair" && Object.hasOwn(repairSummaries, item.summary)) {
    return t(`chatActivity.${repairSummaries[item.summary]}`);
  }
  if (item.kind === "health" && item.summary === "GitHub webhook recovery needs attention") {
    return t("chatActivity.githubRecoveryNeedsAttention");
  }
  if (item.kind === "delivery" && CHAT_DELIVERY_STATES.some((state) => state === item.status)) {
    const outcome = item.status === "filtered" ? "ignored" : item.status;
    for (const event of CHAT_EVENT_KINDS) {
      const prefix = `${event.replaceAll("_", " ")} ${outcome}`;
      if (item.summary !== prefix && !item.summary.startsWith(`${prefix} · `)) continue;
      const suffix = item.summary.slice(prefix.length);
      const duplicate = suffix.match(/^ · ([1-9][0-9]*) duplicate(s?) ignored$/);
      const count = duplicate ? Number(duplicate[1]) : 0;
      if (suffix && (!duplicate || !Number.isSafeInteger(count) || duplicate[2] !== (count === 1 ? "" : "s"))) continue;
      const label = t("chatActivity.deliverySummary", { event: t(`chatActivity.event.${event}`), outcome: t(`chatActivity.outcome.${outcome}`) });
      return suffix ? `${label} · ${t("chatActivity.duplicatesIgnored", { count, formattedCount: formatNumber(count) })}` : label;
    }
  }
  return item.summary;
}
