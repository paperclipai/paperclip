/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** stable machine key (e.g. "five_hour", "seven_day"), null when the window has no known key */
  key?: string | null;
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
  /** error message when ok is false, or the latest failed read when `stale` is true */
  error?: string;
  /** True when the latest read was throttled by the provider (HTTP 429), not broken. */
  rateLimited?: boolean;
  /**
   * ISO timestamp of the provider read that produced `windows`. Set by the
   * server's memoized quota snapshot; absent on a raw adapter result.
   */
  observedAt?: string | null;
  /**
   * True when the latest provider read failed and `windows` still come from
   * the last successful read, which is no older than the snapshot's stale
   * bound. `ok` stays true so consumers keep using the last known usage.
   */
  stale?: boolean;
  windows: QuotaWindow[];
}
