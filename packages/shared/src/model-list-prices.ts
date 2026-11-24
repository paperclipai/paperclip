/**
 * Public pay-per-token API list prices, used to show what subscription usage
 * would cost on the API ("API-equivalent"). This is an estimate for comparison
 * only: it never feeds ledger spend, budgets or invoices, and it ignores
 * long-context and >100K-token pricing tiers.
 *
 * Sources: https://platform.claude.com/docs/en/about-claude/pricing and
 * https://developers.openai.com/api/docs/pricing (retrieved 2026-11-24).
 * Update the table and the version together when prices change.
 */
export const MODEL_LIST_PRICES_VERSION = "list-prices-2026-11-24";

/** USD per 1M tokens: [input, cached input, cache write, output]. */
type Rates = readonly [number, number, number, number];

const LIST_PRICES: Record<string, Rates> = {
  "claude-fable-5-2": [8, 0.2, 16, 40],
  "claude-opus-5-5": [4, 0.2, 8, 20],
  "claude-opus-5": [5, 0.5, 10, 25],
  "claude-sonnet-5-5": [2, 0.1, 4, 10],
  "claude-sonnet-5": [2, 0.2, 4, 10],
  "claude-sonnet-4-6": [3, 0.3, 6, 15],
  "claude-haiku-5-5": [0.1, 0.01, 0.2, 0.5],
  "claude-haiku-4-5": [1, 0.1, 2, 5],
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6-sol": [2, 0.2, 2.5, 10],
  "gpt-6.1-sol": [2, 0.1, 2.5, 10],
  "gpt-6.1-terra": [1, 0.05, 1.25, 5],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
};

/** Claude Code model-picker aliases resolve to the current model of that tier. */
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

export function resolveListPriceModel(model: string): string | null {
  // Claude Code reports dated snapshots and context markers, e.g. `claude-haiku-4-5-20251001`, `claude-opus-5-5[1m]`.
  const name = model.trim().toLowerCase().replace(/^(anthropic|openai)\//, "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  if (!name) return null;
  const resolved = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  return Object.hasOwn(LIST_PRICES, resolved) ? resolved : null;
}

export interface ListPriceTokens {
  /** Includes cache-write tokens, as the ledger records them. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
}

/** Cents at list price, or null when the model is unknown or the counts are impossible. */
export function priceAtListPrice(model: string, tokens: ListPriceTokens): number | null {
  const key = resolveListPriceModel(model);
  if (!key) return null;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const counts = [tokens.inputTokens - cacheWrite, tokens.cachedInputTokens, cacheWrite, tokens.outputTokens];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return null;
  const rates = LIST_PRICES[key];
  // USD per 1M tokens equals cents per 10K tokens.
  return counts.reduce((cents, count, index) => cents + (count * rates[index]) / 10_000, 0);
}
