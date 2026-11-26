const DEFAULT_OAUTH_FAILURE_MESSAGE = "Authorization did not complete. Try again when you’re ready.";

const OAUTH_PROVIDER_ERROR_COPY = new Map<string, string>([
  ["invalid_scope", "The provider rejected the requested permissions. Check your OAuth app’s configured scopes and try again."],
  ["invalid_redirect_uri", "The provider rejected Paperclip’s callback URL. Check that the callback URL in your OAuth app matches Paperclip and try again."],
  ["invalid_client", "The provider rejected this OAuth app’s client credentials. Check your client ID and secret and try again."],
  ["unauthorized_client", "The provider refused to authorize this OAuth app. Check your OAuth app configuration and try again."],
  ["invalid_grant", "The provider rejected the authorization code. Try signing in again."],
  ["invalid_request", "The provider rejected the sign-in request. Check your OAuth app settings and try again."],
  ["invalid_client_metadata", "The provider rejected Paperclip’s client registration details. Try again or use your own OAuth app."],
  ["invalid_software_statement", "The provider rejected Paperclip’s client registration details. Try again or use your own OAuth app."],
  ["unapproved_software_statement", "The provider rejected Paperclip’s client registration details. Try again or use your own OAuth app."],
  ["unsupported_grant_type", "The provider does not support the OAuth grant Paperclip uses."],
  ["unsupported_response_type", "The provider does not support the OAuth sign-in flow Paperclip uses."],
  ["server_error", "The provider reported an internal error. Try again shortly."],
  ["temporarily_unavailable", "The provider is temporarily unavailable. Try again shortly."],
  ["account_selection_required", "The provider requires you to select an account. Try connecting again."],
  ["consent_required", "The provider requires consent to be granted. Try connecting again."],
  ["interaction_required", "The provider requires interactive sign-in. Try connecting again."],
  ["login_required", "The provider requires you to sign in first. Try connecting again."],
]);

export function allowlistedOAuthProviderError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "access_denied" || OAUTH_PROVIDER_ERROR_COPY.has(value)) return value;
  return null;
}

export function readConnectionIntentOAuthFailureCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
}

export function readConnectionIntentOAuthProviderError(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  return allowlistedOAuthProviderError((data as { providerError?: unknown }).providerError);
}

export function oauthFailureMessage(code: string | null, providerError?: string | null): string {
  const safeProviderError = allowlistedOAuthProviderError(providerError);
  if (safeProviderError && safeProviderError !== "access_denied") {
    const providerCopy = OAUTH_PROVIDER_ERROR_COPY.get(safeProviderError);
    if (providerCopy) return providerCopy;
  }
  switch (code) {
    case "oauth_state_expired":
    case "oauth_state_missing":
      return "The sign-in took too long or was already used. Try again and finish signing in within a few minutes.";
    case "oauth_session_mismatch":
      return "Sign-in finished in a different Paperclip session. Stay signed in to Paperclip in this browser and try again.";
    case "oauth_redirect_origin_unsupported":
      return "Sign-in returned to a different Paperclip address than the one you started from. Open Paperclip at its usual address and try again.";
    case "oauth_token_exchange_failed":
    case "oauth_token_endpoint_rejected":
    case "oauth_access_token_missing":
      return "The provider accepted your sign-in but didn’t give Paperclip access. Try again; if it keeps happening, check that your account or organization allows this app.";
    case "oauth_insufficient_scope":
    case "oauth_scope_grant_invalid":
      return "The provider didn’t grant the access Paperclip asked for. Try again and approve every requested permission.";
    case "slack_mcp_access_disabled":
      return "Slack MCP access is disabled for this app. Ask the Slack app owner to enable Model Context Protocol under Features → Agents & AI Apps, then try again.";
    case "github_installation_required":
      return "You signed in, but the Paperclip for GitHub app isn’t installed on any account you can use. Install it and choose at least one repository, then try again. An organization owner may need to approve the install.";
    default:
      return DEFAULT_OAUTH_FAILURE_MESSAGE;
  }
}

export function oauthCallbackErrorMessage(
  outcome: string | null,
  code: string | null,
  providerError?: string | null,
): string {
  const safeProviderError = allowlistedOAuthProviderError(providerError);
  if (code === "github_installation_required") {
    return "GitHub access is required. Install Paperclip and grant at least one repository, then try again.";
  }
  const specific = oauthFailureMessage(
    code && code !== "oauth_authorization_denied" ? code : null,
    safeProviderError,
  );
  if (specific !== DEFAULT_OAUTH_FAILURE_MESSAGE) return specific;
  if (outcome === "denied" || safeProviderError === "access_denied") {
    return "Authorization was cancelled or declined. Your saved connection was not changed.";
  }
  return "Authorization did not complete. Your saved connection is still here, so you can try again.";
}
