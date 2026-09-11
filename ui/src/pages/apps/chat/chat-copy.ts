import { t } from "@/i18n";

export type ChatUiError = string | { key: string };

/** Local errors carry keys; provider diagnostics remain verbatim. */
export function chatUiErrorMessage(error: ChatUiError | null): string | null {
  return typeof error === "string" || error === null ? error : t(error.key);
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
