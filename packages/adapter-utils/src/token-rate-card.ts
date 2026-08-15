/**
 * Biller-level token rate card.
 *
 * Some billers do not sell tokens at API list prices. GitHub Copilot bills
 * agent traffic against *premium credits*: every token — input, cached input,
 * and output — consumes the same credit budget, and a cache read is **not**
 * discounted.
 *
 * Coding CLIs report a `costUsd` computed from an API-shaped price table
 * (input / output / cacheRead, with cacheRead typically at ~10% of input).
 * Passing that number through understates a credit-billed lane by roughly the
 * inverse of the cache-read discount times the cached share of volume. On a
 * long-running agent workload where cache reads are ~99% of tokens, that is an
 * order-of-magnitude error — measured at 12.3x against a real Copilot org bill.
 *
 * So for these billers Paperclip re-prices the run from token counts instead of
 * trusting the CLI's cost field.
 */

import type { AdapterBillingType, UsageSummary } from "./types.js";

/** Env var carrying operator overrides, merged over {@link DEFAULT_TOKEN_RATE_CARD}. */
export const TOKEN_RATE_CARD_ENV_KEY = "PAPERCLIP_TOKEN_RATE_CARD_JSON";

export interface TokenRateCardEntry {
  /**
   * USD charged per 1,000 tokens, applied uniformly to input, cached input and
   * output. A blended rate is intentional: credit-metered billers do not expose
   * a per-token-class price.
   */
  usdPerThousandTokens: number;
  /** Billing type stamped on the cost event for this biller. */
  billingType: AdapterBillingType;
  /**
   * Optional per-model multipliers on {@link usdPerThousandTokens}, keyed by the
   * model id with any `provider/` prefix stripped. Matching is case-insensitive
   * and longest-prefix, so `"claude-opus"` covers `claude-opus-4.5`.
   *
   * Empty by default: GitHub does not publish a per-model token multiplier for
   * credit-metered usage, and a guessed split is worse than a blended rate that
   * reconciles in aggregate.
   */
  modelMultipliers?: Record<string, number>;
  /** Why this entry exists. Surfaced in the priced result for auditability. */
  note?: string;
}

/**
 * Built-in entries. Only billers whose *published* billing model diverges from
 * token list pricing belong here — anything else keeps the CLI-reported cost.
 */
export const DEFAULT_TOKEN_RATE_CARD: Readonly<Record<string, TokenRateCardEntry>> = Object.freeze({
  "github-copilot": {
    // ~1 premium credit per ~1,000 tokens at $0.01 per credit. Cross-checked
    // against metered credits vs token volume on a real org bill: 1,087 tokens
    // per credit, i.e. a realized $0.0092 per 1,000 tokens.
    usdPerThousandTokens: 0.0092,
    billingType: "credits",
    note: "GitHub Copilot premium credits: cache reads are billed at full rate, not discounted.",
  },
});

function normalizeBillerKey(biller: string | null | undefined): string | null {
  const trimmed = typeof biller === "string" ? biller.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelKey(model: string | null | undefined): string {
  const trimmed = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (trimmed.length === 0) return "";
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The full {@link AdapterBillingType} union, used to validate operator overrides. */
const KNOWN_BILLING_TYPES: ReadonlySet<AdapterBillingType> = new Set([
  "api",
  "subscription",
  "metered_api",
  "subscription_included",
  "subscription_overage",
  "credits",
  "fixed",
  "unknown",
]);

function isKnownBillingType(value: unknown): value is AdapterBillingType {
  return typeof value === "string" && KNOWN_BILLING_TYPES.has(value as AdapterBillingType);
}

function parseEntry(value: unknown): TokenRateCardEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNonNegative(raw.usdPerThousandTokens)) return null;
  // An operator override with an unsupported billingType (typo, unknown
  // value) must not silently replace a valid built-in entry: that would
  // reintroduce the `unknown` billing-type misclassification this rate card
  // exists to fix. Reject the whole entry so the built-in falls through.
  if (raw.billingType !== undefined && !isKnownBillingType(raw.billingType)) return null;
  const multipliers: Record<string, number> = {};
  if (raw.modelMultipliers && typeof raw.modelMultipliers === "object") {
    for (const [model, multiplier] of Object.entries(raw.modelMultipliers as Record<string, unknown>)) {
      // An empty, whitespace-only, or provider-only key (e.g. "provider/")
      // normalizes to "", and every model id starts with "" -- storing it
      // would silently apply the multiplier to every model for this biller.
      const key = normalizeModelKey(model);
      if (key && isFiniteNonNegative(multiplier)) multipliers[key] = multiplier;
    }
  }
  return {
    usdPerThousandTokens: raw.usdPerThousandTokens,
    billingType: isKnownBillingType(raw.billingType) ? raw.billingType : "credits",
    ...(Object.keys(multipliers).length > 0 ? { modelMultipliers: multipliers } : {}),
    ...(typeof raw.note === "string" && raw.note.trim().length > 0 ? { note: raw.note.trim() } : {}),
  };
}

/**
 * Reads operator overrides from the runtime env. The value is a JSON object
 * keyed by biller, e.g.:
 *
 * ```json
 * {"google":{"usdPerThousandTokens":0,"billingType":"fixed","note":"AI Studio free tier"}}
 * ```
 *
 * Overrides replace a built-in entry for the same biller. Malformed JSON or
 * malformed entries are ignored rather than failing the run: a bad rate card
 * must never take an agent offline.
 */
export function resolveTokenRateCard(
  env: Record<string, string | undefined> = {},
): Record<string, TokenRateCardEntry> {
  const card: Record<string, TokenRateCardEntry> = { ...DEFAULT_TOKEN_RATE_CARD };
  const raw = env[TOKEN_RATE_CARD_ENV_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) return card;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return card;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return card;
  for (const [biller, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = normalizeBillerKey(biller);
    if (!key) continue;
    const entry = parseEntry(value);
    if (entry) card[key] = entry;
  }
  return card;
}

export function lookupTokenRateCardEntry(
  biller: string | null | undefined,
  env: Record<string, string | undefined> = {},
): TokenRateCardEntry | null {
  const key = normalizeBillerKey(biller);
  if (!key) return null;
  return resolveTokenRateCard(env)[key] ?? null;
}

function resolveModelMultiplier(entry: TokenRateCardEntry, model: string | null | undefined): number {
  const multipliers = entry.modelMultipliers;
  if (!multipliers) return 1;
  const key = normalizeModelKey(model);
  if (!key) return 1;
  const exact = multipliers[key];
  if (isFiniteNonNegative(exact)) return exact;
  let best: { prefix: string; multiplier: number } | null = null;
  for (const [prefix, multiplier] of Object.entries(multipliers)) {
    if (!key.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, multiplier };
  }
  return best?.multiplier ?? 1;
}

export function totalBilledTokens(usage: UsageSummary | null | undefined): number {
  if (!usage) return 0;
  const input = isFiniteNonNegative(usage.inputTokens) ? usage.inputTokens : 0;
  const cached = isFiniteNonNegative(usage.cachedInputTokens) ? (usage.cachedInputTokens ?? 0) : 0;
  const output = isFiniteNonNegative(usage.outputTokens) ? usage.outputTokens : 0;
  return input + cached + output;
}

/** Price a run's token usage with a rate card entry. Cached input is NOT discounted. */
export function priceUsageWithRateCard(
  entry: TokenRateCardEntry,
  usage: UsageSummary | null | undefined,
  model?: string | null,
): number {
  const tokens = totalBilledTokens(usage);
  if (tokens <= 0) return 0;
  const rate = entry.usdPerThousandTokens * resolveModelMultiplier(entry, model);
  return (tokens / 1000) * rate;
}

export interface AppliedTokenRateCard {
  costUsd: number | null;
  billingType: AdapterBillingType;
  /** `"rate_card"` when Paperclip re-priced the run, `"adapter"` when the CLI's cost stands. */
  pricingSource: "rate_card" | "adapter";
  rateCardNote?: string;
}

/**
 * Decides the cost and billing type recorded for a run.
 *
 * When the biller has a rate card entry, the CLI-reported cost is replaced by
 * the token-derived price and the entry's billing type is stamped. Otherwise
 * the reported cost and billing type pass through untouched.
 */
export function applyTokenRateCard(input: {
  biller: string | null | undefined;
  model?: string | null;
  usage?: UsageSummary | null;
  reportedCostUsd?: number | null;
  reportedBillingType?: AdapterBillingType | null;
  env?: Record<string, string | undefined>;
}): AppliedTokenRateCard {
  const fallback: AppliedTokenRateCard = {
    costUsd: isFiniteNonNegative(input.reportedCostUsd) ? input.reportedCostUsd : null,
    billingType: input.reportedBillingType ?? "unknown",
    pricingSource: "adapter",
  };
  const entry = lookupTokenRateCardEntry(input.biller, input.env ?? {});
  if (!entry) return fallback;
  return {
    costUsd: priceUsageWithRateCard(entry, input.usage, input.model),
    billingType: entry.billingType,
    pricingSource: "rate_card",
    ...(entry.note ? { rateCardNote: entry.note } : {}),
  };
}
