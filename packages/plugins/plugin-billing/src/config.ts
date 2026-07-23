export type TrialPolicy = "first-company-per-owner" | "every-company" | "none";

export interface BillingConfig {
  /** ISO 4217 code, e.g. "EUR". */
  currency: string;
  defaultMonthlyPriceCents: number;
  trialDays: number;
  /** Aligned with provider dunning windows. */
  graceDays: number;
  trialPolicy: TrialPolicy;
  provider: "stub";
  /** Base URL the stub provider posts its signed events back to. */
  instanceBaseUrl: string;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  currency: "EUR",
  defaultMonthlyPriceCents: 4900,
  trialDays: 7,
  graceDays: 7,
  trialPolicy: "first-company-per-owner",
  provider: "stub",
  instanceBaseUrl: "http://127.0.0.1:3100",
};

const TRIAL_POLICIES: readonly TrialPolicy[] = ["first-company-per-owner", "every-company", "none"];

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Per-field lenient parse. Billing must never crash on a bad config value:
 * an unparseable field falls back to its spec §3 default.
 */
export function parseBillingConfig(raw: Record<string, unknown> | null | undefined): BillingConfig {
  const input = raw ?? {};
  return {
    currency: typeof input.currency === "string" && /^[A-Za-z]{3}$/.test(input.currency)
      ? input.currency.toUpperCase()
      : DEFAULT_BILLING_CONFIG.currency,
    defaultMonthlyPriceCents: nonNegativeInt(input.defaultMonthlyPriceCents, DEFAULT_BILLING_CONFIG.defaultMonthlyPriceCents),
    trialDays: nonNegativeInt(input.trialDays, DEFAULT_BILLING_CONFIG.trialDays),
    graceDays: nonNegativeInt(input.graceDays, DEFAULT_BILLING_CONFIG.graceDays),
    trialPolicy: TRIAL_POLICIES.includes(input.trialPolicy as TrialPolicy)
      ? (input.trialPolicy as TrialPolicy)
      : DEFAULT_BILLING_CONFIG.trialPolicy,
    provider: "stub",
    instanceBaseUrl: nonEmptyString(input.instanceBaseUrl, DEFAULT_BILLING_CONFIG.instanceBaseUrl),
  };
}
