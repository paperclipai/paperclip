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
}

export type LocalProviderAuthState = "ready" | "missing" | "unknown" | "error";
export type LocalProviderQuotaState = "ok" | "low" | "exhausted" | "unknown" | "error";

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** adapter slug that produced this result when applicable */
  adapterType?: string | null;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** local OAuth/session auth state for local subscription-backed adapters */
  authState?: LocalProviderAuthState;
  /** normalized quota state for operator gating and status UI */
  quotaState?: LocalProviderQuotaState;
  /** next operator action when auth/quota is not fully ready */
  action?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}
