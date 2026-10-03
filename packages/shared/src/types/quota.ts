/**
 * role of a quota window for run pacing:
 * - "session": the account-wide short rolling window (for example 5 hours)
 * - "weekly": the account-wide weekly window
 * - "other": model-scoped windows, credits, and extra usage
 */
export type QuotaWindowKind = "session" | "weekly" | "other";

/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
  /** role of the window, when the adapter classifies it; see QuotaWindowKind */
  kind?: QuotaWindowKind | null;
  /** length of the rolling window in seconds, when known */
  windowSeconds?: number | null;
}

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** machine-readable error family when ok is false */
  errorFamily?: string | null;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
  /**
   * when the server fetched this result from the provider (ISO 8601). The
   * server reuses a result for a short time, so it can be older than the
   * request that returned it.
   */
  fetchedAt?: string | null;
}
