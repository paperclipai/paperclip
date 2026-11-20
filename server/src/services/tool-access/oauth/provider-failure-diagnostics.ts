// Server-only, fixed-shape record of an OAuth provider's HTTP answer, for error
// reporting. It holds the response status and the already-allowlisted provider
// error label: never the provider's URL, body, description or headers.

export type OAuthProviderFailureOperation = "dynamic_client_registration";

export interface OAuthProviderFailureDiagnostics {
  operation: OAuthProviderFailureOperation;
  httpStatus: number;
  /** `normalizeOAuthProviderError` output: an RFC code, `unrecognized`, or null. */
  providerError: string | null;
}

const recorded = new WeakMap<Error, Readonly<OAuthProviderFailureDiagnostics>>();

export function recordOAuthProviderFailure<T extends Error>(error: T, diagnostics: OAuthProviderFailureDiagnostics): T {
  recorded.set(error, Object.freeze({ ...diagnostics }));
  return error;
}

export function oauthProviderFailureDiagnosticsFor(error: unknown): Readonly<OAuthProviderFailureDiagnostics> | null {
  return error instanceof Error ? recorded.get(error) ?? null : null;
}
