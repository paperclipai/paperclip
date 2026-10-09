import type { ProviderQuotaResult } from "@paperclipai/shared";

const invalidCredentials = new Set([
  "credentials_unavailable",
  "authentication_required",
  "refresh_token_reused",
  "refresh_token_expired",
  "refresh_token_invalidated",
]);

/** Keep last successful windows through transient failures, never revoked auth. */
export function retainQuotaWindows(
  previous: ProviderQuotaResult[] | undefined,
  incoming: ProviderQuotaResult[],
): ProviderQuotaResult[] {
  return incoming.map((result) => {
    if (result.ok || (result.errorFamily && invalidCredentials.has(result.errorFamily))) return result;
    const last = previous?.find((entry) => entry.provider === result.provider && entry.accountKey === result.accountKey);
    return last?.windows.length
      ? { ...result, windows: last.windows, source: last.source, capturedAt: last.capturedAt }
      : result;
  });
}

// Never render adapter diagnostics, even when talking to an older server.
export function quotaUnavailableMessage(hasPreviousWindows: boolean): string {
  return hasPreviousWindows
    ? "Showing the last available quota. Updates will resume automatically."
    : "Subscription quota is currently unavailable. Check usage with your provider.";
}
