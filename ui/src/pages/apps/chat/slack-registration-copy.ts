import { t } from "@/i18n";

const registrationKeys: Record<string, string> = {
  "slack_managed_unavailable": "oct19Apps.registration_slack_managed_unavailable",
  "slack_manager_reauthorize": "oct19Apps.registration_slack_manager_reauthorize",
  "slack_approval_pending": "oct19Apps.registration_slack_approval_pending",
  "slack_approval_required": "oct19Apps.registration_slack_approval_required",
  "slack_approval_denied": "oct19Apps.registration_slack_approval_denied",
  "slack_configuration_token_invalid": "oct19Apps.registration_slack_configuration_token_invalid",
  "slack_manifest_invalid": "oct19Apps.registration_slack_manifest_invalid",
  "slack_manifest_update_pending": "oct19Apps.registration_slack_manifest_update_pending",
  "slack_setup_rate_limited": "oct19Apps.registration_slack_setup_rate_limited",
  "slack_setup_permission_denied": "oct19Apps.registration_slack_setup_permission_denied",
  "slack_creation_uncertain": "oct19Apps.registration_slack_creation_uncertain",
  "slack_install_declined": "oct19Apps.registration_slack_install_declined",
  "slack_install_expired": "oct19Apps.registration_slack_install_expired",
  "slack_install_failed": "oct19Apps.registration_slack_install_failed",
  "slack_install_identity_mismatch": "oct19Apps.registration_slack_install_identity_mismatch",
  "slack_install_scopes_missing": "oct19Apps.registration_slack_install_scopes_missing",
  "slack_bot_already_connected": "oct19Apps.registration_slack_bot_already_connected",
  "slack_install_token_invalid": "oct19Apps.registration_slack_install_token_invalid",
  "slack_configuration_incomplete": "oct19Apps.registration_slack_configuration_incomplete",
  "slack_install_account_missing": "oct19Apps.registration_slack_install_account_missing",
  "slack_install_account_conflict": "oct19Apps.registration_slack_install_account_conflict",
};

/** Display-only mapping: service codes, protocol strings, and unknown diagnostics are unchanged. */
export function slackRegistrationDisplayError(code: string): string {
  if (Object.hasOwn(registrationKeys, code)) return t(registrationKeys[code]);
  return t("oct19Apps.registrationFallback");
}
