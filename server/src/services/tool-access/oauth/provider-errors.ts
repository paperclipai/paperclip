

/**
 * Upstream OAuth error redaction (PAP-17108).
 *
 * A generic remote MCP connection points at an arbitrary authorization server,
 * so everything that server says about a failure is attacker-chosen: `error`,
 * `error_description`, `error_uri`, and the response body. Paperclip surfaces
 * connection failures to the operator through API responses, board UI copy,
 * audit rows and logs, so reflecting any of that text would let a hostile
 * provider plant secrets, ANSI escapes, or instructions ("paste your recovery
 * key here") into Paperclip's own voice.
 *
 * The rule is therefore: the operator only ever reads text Paperclip authored.
 * The provider's `error` code survives — as a *label* in structured `details`,
 * never in a message — and only when it is one of the codes the RFCs define,
 * because a label is still untrusted input. Everything else is dropped, and an
 * unrecognized code collapses to `unrecognized` rather than being echoed.
 *
 * `error_description` and the response body are never read at all: no call site
 * below parses them, which is what keeps a future edit from quietly
 * reintroducing the reflection.
 */
const OAUTH_PROVIDER_ERROR_CODES = new Set([
  // RFC 6749 §4.1.2.1 — authorization endpoint (the callback-denial path).
  "access_denied",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_response_type",
  // RFC 6749 §5.2 — token endpoint (authorization-code and refresh exchanges).
  "invalid_client",
  "invalid_grant",
  "unsupported_grant_type",
  // RFC 7591 §3.2.2 — dynamic client registration.
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_software_statement",
  "unapproved_software_statement",
  // OpenID Connect Core §3.1.2.6 — interactive re-authentication prompts.
  "account_selection_required",
  "consent_required",
  "interaction_required",
  "login_required",
]);

/** What an `error` that is absent, malformed, or off the allowlist becomes. */
const UNRECOGNIZED_OAUTH_PROVIDER_ERROR = "unrecognized";

const MAX_OAUTH_PROVIDER_ERROR_LENGTH = 64;

const OAUTH_PROVIDER_ERROR_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Stable, Paperclip-authored operator copy for each allowlisted provider error.
 * Deliberately keyed on the code alone: the calling context is already carried
 * by the Paperclip `code` in `details`, so one table serves the callback,
 * token-exchange and registration paths without any of them composing a message
 * out of provider text.
 */
const OAUTH_PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "The authorization server denied the request.",
  account_selection_required:
    "The authorization server needs an account to be selected. Try connecting again.",
  consent_required:
    "The authorization server needs consent to be granted. Try connecting again.",
  interaction_required:
    "The authorization server needs to be signed in to interactively. Try connecting again.",
  invalid_client: "The authorization server rejected Paperclip's OAuth client.",
  invalid_client_metadata:
    "The authorization server rejected Paperclip's client registration details.",
  invalid_grant:
    "The authorization server rejected the authorization code or refresh token.",
  invalid_redirect_uri:
    "The authorization server rejected Paperclip's callback URL.",
  invalid_request:
    "The authorization server rejected the request as malformed.",
  invalid_scope: "The authorization server rejected the requested permissions.",
  invalid_software_statement:
    "The authorization server rejected Paperclip's client registration details.",
  login_required:
    "The authorization server needs to be signed in to. Try connecting again.",
  server_error:
    "The authorization server reported an internal error. Try again shortly.",
  temporarily_unavailable:
    "The authorization server is temporarily unavailable. Try again shortly.",
  unapproved_software_statement:
    "The authorization server rejected Paperclip's client registration details.",
  unauthorized_client:
    "The authorization server refused to authorize Paperclip's OAuth client.",
  unsupported_grant_type:
    "The authorization server does not support the grant Paperclip uses.",
  unsupported_response_type:
    "The authorization server does not support the sign-in flow Paperclip uses.",
};

/**
 * Reduce a provider-supplied `error` to a bounded, allowlisted label safe to
 * keep in structured `details`. Returns `null` only when the provider sent no
 * `error` at all, so the caller can tell "silent failure" from "said something
 * Paperclip does not recognize".
 */
export function normalizeOAuthProviderError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Bound length and character class before the allowlist even though
  // membership implies both: these limits are what keeps the label safe if the
  // allowlist above ever grows a pattern-matched entry.
  if (value.length > MAX_OAUTH_PROVIDER_ERROR_LENGTH)
    return UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
  if (!OAUTH_PROVIDER_ERROR_PATTERN.test(value))
    return UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
  return OAUTH_PROVIDER_ERROR_CODES.has(value)
    ? value
    : UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
}

/** Paperclip's own message for a provider failure, never the provider's. */
export function oauthProviderErrorMessage(
  providerError: string | null,
  fallback: string,
): string {
  if (!providerError) return fallback;
  return OAUTH_PROVIDER_ERROR_MESSAGES[providerError] ?? fallback;
}
