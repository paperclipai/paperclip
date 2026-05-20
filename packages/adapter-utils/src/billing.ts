function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}

// ---------------------------------------------------------------------------
// Anthropic subscription-spend estimator
// ---------------------------------------------------------------------------
//
// Adapters that run Claude under OAuth Max (i.e. on the user's Claude Code
// subscription rather than a metered API key) receive token usage from the
// provider but no `total_cost_usd` field — so downstream cost accounting
// stores `cost_cents = 0`, `monthSpendCents` stays at $0, and budget signals
// are flat. See RFC paperclipai/paperclip#5066.
//
// `estimateAnthropicCostUsd` produces a usage-proxy cost from published API
// prices. It is an ESTIMATE, not an invoice — the subscription user does not
// actually pay this amount; it lets the operator see proportional consumption
// relative to other agents and tier budgets.
//
// Pricing table is small + literal so future updates leave a clear paper
// trail. Rate keys are matched longest-prefix-wins against the model id
// returned by the provider (e.g. "claude-sonnet-4-7-20251008" matches the
// "claude-sonnet-4-7" entry; falls back to "claude-sonnet" or "default").

export interface AnthropicRate {
  /** USD per 1M input tokens (non-cached). */
  input: number;
  /** USD per 1M cache-read input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface AnthropicPricingTable {
  /** ISO date the table was last verified. */
  asOf: string;
  /** Public URL the rates were sourced from. */
  source: string;
  /** Rates keyed by model-id prefix (or "default"). */
  rates: Record<string, AnthropicRate>;
}

/**
 * Published Anthropic API prices in USD per 1M tokens. Updated when the
 * upstream pricing page changes — leave the AS-OF date in sync.
 *
 * AS-OF 2026-05-19. Source: https://www.anthropic.com/pricing
 */
export const ANTHROPIC_MODEL_PRICING: AnthropicPricingTable = {
  asOf: "2026-05-19",
  source: "https://www.anthropic.com/pricing",
  rates: {
    "claude-opus-4-7":   { input: 15.00, cachedInput: 1.50, output: 75.00 },
    "claude-opus":       { input: 15.00, cachedInput: 1.50, output: 75.00 },
    "claude-sonnet-4-6": { input:  3.00, cachedInput: 0.30, output: 15.00 },
    "claude-sonnet":     { input:  3.00, cachedInput: 0.30, output: 15.00 },
    "claude-haiku-4-5":  { input:  1.00, cachedInput: 0.10, output:  5.00 },
    "claude-haiku":      { input:  1.00, cachedInput: 0.10, output:  5.00 },
    default:             { input:  3.00, cachedInput: 0.30, output: 15.00 },
  },
};

export interface AnthropicUsage {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

function resolveRate(model: string | null | undefined, table: AnthropicPricingTable): AnthropicRate {
  const key = (model ?? "").toLowerCase();
  let bestPrefix = "";
  for (const prefix of Object.keys(table.rates)) {
    if (prefix === "default") continue;
    if (key.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
    }
  }
  return table.rates[bestPrefix] ?? table.rates.default;
}

/**
 * Compute an estimated USD cost from token usage using the supplied (or
 * default) Anthropic pricing table. Returns `null` if usage is missing.
 *
 * Caller is responsible for marking the resulting cost as an estimate —
 * this function does not classify itself as a real invoice.
 */
export function estimateAnthropicCostUsd(
  model: string | null | undefined,
  usage: AnthropicUsage | null | undefined,
  table: AnthropicPricingTable = ANTHROPIC_MODEL_PRICING,
): number | null {
  if (!usage) return null;
  const rate = resolveRate(model, table);
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  if (input === 0 && cached === 0 && output === 0) return 0;
  return (
    (input * rate.input) / 1_000_000 +
    (cached * rate.cachedInput) / 1_000_000 +
    (output * rate.output) / 1_000_000
  );
}
