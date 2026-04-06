// ---------------------------------------------------------------------------
// Fallback token-based pricing (USD per 1M tokens)
//
// Used when adapters don't report costUsd so the system can still estimate
// costs from token counts.  Rates are approximate list prices as of 2025-Q2.
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic Claude 4 family ──────────────────────────────────────────
  "claude-sonnet-4-20250514":      { inputPerMillion: 3,   outputPerMillion: 15,  cachedInputPerMillion: 0.30 },
  "claude-opus-4-20250514":        { inputPerMillion: 15,  outputPerMillion: 75,  cachedInputPerMillion: 1.50 },

  // ── Anthropic Claude 3.5 / 3.7 family ─────────────────────────────────
  "claude-3-7-sonnet-20250219":    { inputPerMillion: 3,   outputPerMillion: 15,  cachedInputPerMillion: 0.30 },
  "claude-3-5-sonnet-20241022":    { inputPerMillion: 3,   outputPerMillion: 15,  cachedInputPerMillion: 0.30 },
  "claude-3-5-haiku-20241022":     { inputPerMillion: 0.80, outputPerMillion: 4,  cachedInputPerMillion: 0.08 },

  // ── Anthropic Claude 3 family ──────────────────────────────────────────
  "claude-3-opus-20240229":        { inputPerMillion: 15,  outputPerMillion: 75,  cachedInputPerMillion: 1.50 },
  "claude-3-sonnet-20240229":      { inputPerMillion: 3,   outputPerMillion: 15,  cachedInputPerMillion: 0.30 },
  "claude-3-haiku-20240307":       { inputPerMillion: 0.25, outputPerMillion: 1.25, cachedInputPerMillion: 0.03 },

  // ── OpenAI GPT-4 family ────────────────────────────────────────────────
  "gpt-4o":                        { inputPerMillion: 2.50, outputPerMillion: 10 },
  "gpt-4o-mini":                   { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  "gpt-4-turbo":                   { inputPerMillion: 10,  outputPerMillion: 30 },
  "gpt-4":                         { inputPerMillion: 30,  outputPerMillion: 60 },

  // ── OpenAI o-series ────────────────────────────────────────────────────
  "o1":                            { inputPerMillion: 15,  outputPerMillion: 60 },
  "o1-mini":                       { inputPerMillion: 3,   outputPerMillion: 12 },
  "o1-pro":                        { inputPerMillion: 150, outputPerMillion: 600 },
  "o3":                            { inputPerMillion: 10,  outputPerMillion: 40 },
  "o3-mini":                       { inputPerMillion: 1.10, outputPerMillion: 4.40 },
  "o4-mini":                       { inputPerMillion: 1.10, outputPerMillion: 4.40 },

  // ── Google Gemini family ───────────────────────────────────────────────
  "gemini-2.5-pro":                { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash":              { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  "gemini-2.0-flash":              { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  "gemini-1.5-pro":                { inputPerMillion: 1.25, outputPerMillion: 5 },
  "gemini-1.5-flash":              { inputPerMillion: 0.075, outputPerMillion: 0.30 },
};

/**
 * Resolve pricing for a model string.  Tries exact match first, then
 * substring match (handles names like "anthropic/claude-3-5-sonnet-20241022").
 */
export function resolveModelPricing(model: string): ModelPricing | null {
  if (!model || model === "unknown") return null;
  const lower = model.toLowerCase();

  // Exact match
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // Substring match — longest key first to prefer more-specific models
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return MODEL_PRICING[key];
  }

  return null;
}

/**
 * Estimate cost in USD from token counts.  Returns null if the model isn't
 * in the pricing table (caller should fall back to 0).
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number | null {
  const pricing = resolveModelPricing(model);
  if (!pricing) return null;

  const regularInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedCost = cachedInputTokens * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) / 1_000_000;
  const inputCost = regularInputTokens * pricing.inputPerMillion / 1_000_000;
  const outputCost = outputTokens * pricing.outputPerMillion / 1_000_000;

  return inputCost + cachedCost + outputCost;
}

/**
 * Estimate cost in **cents** (rounded) for a cost_event row.
 * Returns 0 if the model isn't recognized.
 */
export function estimateCostForEvent(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  const usd = estimateCostUsd(model, inputTokens, outputTokens, cachedInputTokens);
  if (usd === null) return 0;
  return Math.max(0, Math.round(usd * 100));
}
