import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { unprocessable } from "../../../../errors.js";
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const providerFailure = (code: string) => unprocessable(slackRegistrationErrorMessage(code), { code });
export const knownProviderErrors: Record<string, string> = {
  app_approval_request_eligible: "slack_approval_required", app_approval_request_pending: "slack_approval_pending",
  app_approval_request_denied: "slack_approval_denied", admin_approval_required: "slack_approval_required",
  manager_app_not_eligible: "slack_managed_unavailable", feature_not_enabled: "slack_managed_unavailable",
  invalid_auth: "slack_configuration_token_invalid", token_expired: "slack_configuration_token_invalid",
  token_revoked: "slack_configuration_token_invalid", not_authed: "slack_configuration_token_invalid",
  invalid_manifest: "slack_manifest_invalid", invalid_app: "slack_manifest_invalid",
  ratelimited: "slack_setup_rate_limited", no_permission: "slack_setup_permission_denied",
  missing_scope: "slack_setup_permission_denied", not_allowed_token_type: "slack_configuration_token_invalid",
};

const timeoutMs = 20_000;
export function createSlackSetupClient(fetchImpl: typeof fetch = fetch) {
  return async function api(method: string, fields: Record<string, string> | FormData, bearer?: string, requiredScopes?: readonly string[]) {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(fields instanceof FormData ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: fields instanceof FormData ? fields : new URLSearchParams(fields),
    });
    // Bound the streamed response as well as the request lifetime.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_048_576) { await reader.cancel(); throw providerFailure("slack_provider_failure"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
    }
    let result: Record<string, unknown>;
    try { result = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { result = {}; }
    if (!response.ok || result.ok !== true) {
      const code = knownProviderErrors[String(result.error)] ?? (response.status === 429 ? "slack_setup_rate_limited" : "slack_provider_failure");
      const retry = Number(response.headers.get("retry-after"));
      if (response.status === 429 || result.error === "ratelimited") {
        throw unprocessable(slackRegistrationErrorMessage("slack_setup_rate_limited"), {
          code: "slack_setup_rate_limited", retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60,
        });
      }
      throw providerFailure(code);
    }
    if (requiredScopes) {
      const granted = new Set((response.headers.get("x-oauth-scopes") ?? "").split(/[, ]+/));
      if (requiredScopes.some(scope => !granted.has(scope))) throw providerFailure("slack_install_scopes_missing");
    }
    return result;
  }
}
