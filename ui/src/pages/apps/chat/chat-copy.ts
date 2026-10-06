import { t } from "@/i18n";

export type ChatUiError = string | { key: string };

const authorizationRejectionKeys = [
  "sep28Apps.authorizationMissing",
  "sep28Apps.authorizationMalformed",
  "sep28Apps.authorizationScheme",
  "sep28Apps.authorizationInsecure",
  "sep28Apps.authorizationCredentials",
  "sep28Apps.authorizationFragment"
];

/** Local errors carry keys; known first-party URL rejections translate at display time. Other diagnostics remain verbatim. */
export function chatUiErrorMessage(error: ChatUiError | null): string | null {
  if (typeof error === "string") {
    const key = authorizationRejectionKeys.find(key => error === t(key, { lng: "en" }));
    return key ? t(key) : error;
  }
  return error === null ? null : t(error.key);
}

const labelKeys: Record<string, string> = {
  settings: "localizationCommonChrome.settings",
  access: "chatUi.labels.access",
  conversations: "chatUi.chatEndpointDetail.conversations",
  activity: "chatUi.labels.activity",
  active: "chatUi.labels.active",
  draft: "chatUi.labels.draft",
  verifying: "chatUi.labels.verifying",
  paused: "pages.apps.connections.statusPaused",
  attention: "pages.apps.connections.statusNeedsAttention",
  revoked: "chatUi.labels.revoked",
  archived: "chatUi.labels.archived",
  consent_pending: "chatUi.externallyConnectedTaskBanner.consentCardQueued",
  consent_sending: "chatUi.externallyConnectedTaskBanner.sendingConsentCard",
  consent_unknown: "chatUi.externallyConnectedTaskBanner.consentCardDeliveryNotConfirmed",
  awaiting_consent: "chatUi.externallyConnectedTaskBanner.awaitingConsent",
  upload_pending: "chatUi.externallyConnectedTaskBanner.uploadQueued",
  uploading: "chatUi.externallyConnectedTaskBanner.uploadingFile",
  upload_unknown: "chatUi.externallyConnectedTaskBanner.fileUploadNotConfirmed",
  file_info_pending: "chatUi.externallyConnectedTaskBanner.fileNotificationQueued",
  file_info_sending: "chatUi.externallyConnectedTaskBanner.sendingFileNotification",
  file_info_unknown: "chatUi.externallyConnectedTaskBanner.fileNotificationNotConfirmed",
  delivered: "chatUi.externallyConnectedTaskBanner.delivered",
  declined: "pages.apps.review.declinedTitle",
  expired: "chatUi.externallyConnectedTaskBanner.consentExpired",
  cancelled: "chatUi.externallyConnectedTaskBanner.cancelledRemoteBytesMayRemain",
  conflict: "chatUi.externallyConnectedTaskBanner.fileDeliveryNeedsReview",
};

export function chatLabel(value: string): string {
  return Object.hasOwn(labelKeys, value) ? t(labelKeys[value]) : value;
}

const githubReviewStatusKeys: Record<string, string> = {
  "queued": "sep28Apps.githubStatus_queued",
  "running": "sep28Apps.githubStatus_running",
  "completed": "sep28Apps.githubStatus_completed",
  "incomplete": "sep28Apps.githubStatus_incomplete",
  "error": "sep28Apps.githubStatus_error",
  "superseded": "sep28Apps.githubStatus_superseded",
  "manual_required": "sep28Apps.githubStatus_manual_required",
  "success": "sep28Apps.githubStatus_success",
  "failure": "sep28Apps.githubStatus_failure",
  "neutral": "sep28Apps.githubStatus_neutral",
  "action_required": "sep28Apps.githubStatus_action_required"
};

/** Review states are display labels; persisted state and conclusions stay unchanged. */
export function githubReviewStatusLabel(value: string): string {
  return Object.hasOwn(githubReviewStatusKeys, value) ? t(githubReviewStatusKeys[value]) : value.replaceAll("_", " ");
}

const slackToolLabelKeys: Record<string, string> = {
  "slack_open_dm": "sep28Apps.slackTool_open_dm",
  "slack_delivery": "sep28Apps.slackTool_delivery",
  "slack_channels": "sep28Apps.slackTool_channels",
  "slack_channel_info": "sep28Apps.slackTool_channel_info",
  "slack_members": "sep28Apps.slackTool_members",
  "slack_user": "sep28Apps.slackTool_user",
  "slack_emoji": "sep28Apps.slackTool_emoji",
  "slack_history": "sep28Apps.slackTool_history",
  "slack_thread": "sep28Apps.slackTool_thread",
  "slack_message": "sep28Apps.slackTool_message",
  "slack_permalink": "sep28Apps.slackTool_permalink",
  "slack_file": "sep28Apps.slackTool_file",
  "slack_search": "sep28Apps.slackTool_search",
  "slack_post_message": "sep28Apps.slackTool_post_message",
  "slack_update_message": "sep28Apps.slackTool_update_message",
  "slack_delete_message": "sep28Apps.slackTool_delete_message",
  "slack_upload_file": "sep28Apps.slackTool_upload_file",
  "slack_reactions": "sep28Apps.slackTool_reactions",
  "slack_add_reaction": "sep28Apps.slackTool_add_reaction",
  "slack_remove_reaction": "sep28Apps.slackTool_remove_reaction",
  "slack_pins": "sep28Apps.slackTool_pins",
  "slack_add_pin": "sep28Apps.slackTool_add_pin",
  "slack_remove_pin": "sep28Apps.slackTool_remove_pin",
  "slack_bookmarks": "sep28Apps.slackTool_bookmarks",
  "slack_add_bookmark": "sep28Apps.slackTool_add_bookmark",
  "slack_remove_bookmark": "sep28Apps.slackTool_remove_bookmark",
  "slack_set_topic": "sep28Apps.slackTool_set_topic",
  "slack_set_purpose": "sep28Apps.slackTool_set_purpose",
  "slack_create_canvas": "sep28Apps.slackTool_create_canvas",
  "slack_read_canvas": "sep28Apps.slackTool_read_canvas",
  "slack_edit_canvas": "sep28Apps.slackTool_edit_canvas",
  "slack_create_list": "sep28Apps.slackTool_create_list",
  "slack_list_items": "sep28Apps.slackTool_list_items",
  "slack_create_list_item": "sep28Apps.slackTool_create_list_item",
  "slack_update_list_item": "sep28Apps.slackTool_update_list_item",
  "slack_edit_list": "sep28Apps.slackTool_edit_list",
  "slack_share_list": "sep28Apps.slackTool_share_list",
  "slack_canvas_sections": "sep28Apps.slackTool_canvas_sections",
  "slack_replace_canvas_section": "sep28Apps.slackTool_replace_canvas_section",
  "slack_create_channel": "sep28Apps.slackTool_create_channel",
  "slack_invite": "sep28Apps.slackTool_invite"
};

export function slackToolLabel(name: string): string {
  return Object.hasOwn(slackToolLabelKeys, name) ? t(slackToolLabelKeys[name]) : name.replace(/^slack_/, "").replaceAll("_", " ");
}

export function slackSearchLimitation(message: string): string {
  const key = "sep28Apps.nativeSearchLimitation";
  return message === t(key, { lng: "en" }) ? t(key) : message;
}

/** Translate only known client-side validation; unknown diagnostics remain verbatim. */
export function slackAppValidationMessage(issue: { code: string; path: PropertyKey[]; message: string }): string {
  const field = issue.path[0];
  if (issue.code === "too_small") {
    if (field === "appName") return t("sep28Apps.slackAppNameRequired");
    if (field === "botName") return t("sep28Apps.slackBotNameRequired");
    if (field === "command") return t("sep28Apps.slackCommandRequired");
  }
  if (issue.code === "too_big") {
    if (field === "appName") return t("sep28Apps.slackAppNameLength");
    if (field === "botName") return t("sep28Apps.slackBotNameLength");
    if (field === "command") return t("sep28Apps.slackCommandLength");
  }
  if (issue.code === "invalid_format") {
    if (field === "botName") return t("sep28Apps.slackBotNameFormat");
    if (field === "command") return t("sep28Apps.slackCommandFormat");
  }
  return issue.message;
}

const githubVerificationCopyKeys = [
  "sep28Apps.verifyDelivery",
  "sep28Apps.verifyDeliveryOk",
  "sep28Apps.verifyDeliveryPending",
  "sep28Apps.verifyApp",
  "sep28Apps.verifyAppOk",
  "sep28Apps.verifyAppWrong",
  "sep28Apps.verifyPermissions",
  "sep28Apps.verifyPermissionsOk",
  "sep28Apps.verifyPermissionsPending",
  "sep28Apps.verifyRepositories",
  "sep28Apps.verifyRepositoriesPending",
  "sep28Apps.verifyRuntime",
  "sep28Apps.verifyRuntimeDetail",
  "sep28Apps.verifyIsolation",
  "sep28Apps.verifyIsolationOk",
  "sep28Apps.verifyIsolationPending",
  "sep28Apps.verifyTools",
  "sep28Apps.verifyToolsOk",
  "sep28Apps.verifyToolsPending"
];

/** Only first-party, known verification copy is localized. Repository/tool names and unknown diagnostics stay verbatim. */
export function githubVerificationText(message: string): string {
  for (const key of githubVerificationCopyKeys) {
    if (message === t(key, { lng: "en" })) return t(key);
  }
  const repositories = /^Restore installation access and refresh: (.+)\.$/.exec(message);
  if (repositories) return t("sep28Apps.verifyRepositoriesRestore", { repositories: repositories[1] });
  const verified = /^GitHub confirmed review access to all (\d+) enabled repositories\.$/.exec(message);
  if (verified) return t("sep28Apps.verifyRepositoriesOk", { count: Number(verified[1]) });
  const tools = /^Repair tool policy for: (.+)\.$/.exec(message);
  if (tools) return t("sep28Apps.verifyToolsDenied", { tools: tools[1] });
  return message;
}
