import { t } from "@/i18n";

// Only canonical Paperclip status values are translated. Unknown values stay intact.
const displayKeys = {
  "publication": {
    "pending": "oct19Core.decision_publication_pending",
    "streaming": "oct19Core.decision_publication_streaming",
    "published": "oct19Core.decision_publication_published",
    "retry": "oct19Core.decision_publication_retry",
    "delivery_unknown": "oct19Core.decision_publication_delivery_unknown",
    "failed": "oct19Core.decision_publication_failed",
    "cancelled": "oct19Core.decision_publication_cancelled",
    "awaiting_consent": "oct19Core.decision_publication_awaiting_consent",
    "suppressed": "oct19Core.decision_publication_suppressed",
    "test": "oct19Core.decision_publication_test"
  },
  "error": {
    "real_reply_started": "oct19Core.decision_error_real_reply_started",
    "disabled": "oct19Core.decision_error_disabled",
    "connection_unavailable": "oct19Core.decision_error_connection_unavailable",
    "not_admitted": "oct19Core.decision_error_not_admitted",
    "provider_failed": "oct19Core.decision_error_provider_failed",
    "interrupted": "oct19Core.decision_error_interrupted",
    "expired": "oct19Core.decision_error_expired",
    "invalid_output": "oct19Core.decision_error_invalid_output",
    "timeout": "oct19Core.decision_error_timeout",
    "refused": "oct19Core.decision_error_refused",
    "provider_auth_failed": "oct19Core.decision_error_provider_auth_failed",
    "provider_rate_limited": "oct19Core.decision_error_provider_rate_limited",
    "access_denied": "oct19Core.decision_error_access_denied",
    "budget_blocked": "oct19Core.decision_error_budget_blocked",
    "not_configured": "oct19Core.decision_error_not_configured",
    "incompatible_connection": "oct19Core.decision_error_incompatible_connection"
  },
  "feature": {
    "settings.test": "oct19Core.decision_feature_settings_test",
    "message": "oct19Core.decision_feature_message"
  }
} as const;

export function decisionHistoryValueDisplay(group: keyof typeof displayKeys, value: string): string {
  const key = (displayKeys[group] as Readonly<Record<string, string>>)[value];
  return key ? t(key) : value;
}
