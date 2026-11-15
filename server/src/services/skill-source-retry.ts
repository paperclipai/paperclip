/** Share retry scheduling between initial imports and subsequent refreshes. */
export function skillSourceRetryAt(error: unknown, failureCount: number, now = new Date()) {
  const backoff = Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(failureCount, 4));
  const providerDelay = error instanceof Error && 'details' in error
    ? (error.details as { retryAfterMs?: unknown } | null)?.retryAfterMs : undefined;
  const delay = typeof providerDelay === 'number' && Number.isFinite(providerDelay)
    ? Math.max(backoff, Math.min(24 * 60 * 60_000, providerDelay)) : backoff;
  return new Date(now.getTime() + delay);
}
