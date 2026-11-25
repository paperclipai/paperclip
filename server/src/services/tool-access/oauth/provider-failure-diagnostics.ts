export type OAuthProviderFailureOperation = "dynamic_client_registration";

export interface OAuthProviderFailureDiagnostics {
  operation: OAuthProviderFailureOperation;
  httpStatus: number;
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
