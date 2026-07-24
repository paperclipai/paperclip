/**
 * Best-effort per-token cost table for Azure OpenAI deployments.
 *
 * Prices are USD per 1M tokens for the underlying model. Azure pricing varies
 * by region and reservation; this table is a conservative default so budget
 * accounting is non-zero out of the box. Operators can override by leaving
 * `costUsd` to null on the AdapterExecutionResult (return `undefined` here)
 * and reporting cost from their own metering pipeline.
 *
 * Update policy: match Azure's published pay-as-you-go regional list price for
 * the "input" and "output" columns for the model family. When in doubt, err
 * high — under-reporting cost defeats Paperclip's budget hard-stop.
 */

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M cached input tokens (Azure prompt cache). */
  cachedInputPer1M?: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
};

const TABLE: Record<string, ModelPrice> = {
  // GPT-4o family (Azure pay-as-you-go, US regions, 2026-Q1 list)
  "gpt-4o":            { inputPer1M: 2.5,   cachedInputPer1M: 1.25,  outputPer1M: 10.0 },
  "gpt-4o-mini":       { inputPer1M: 0.15,  cachedInputPer1M: 0.075, outputPer1M: 0.60 },
  "gpt-4.1":           { inputPer1M: 2.0,   cachedInputPer1M: 0.50,  outputPer1M: 8.0 },
  "gpt-4.1-mini":      { inputPer1M: 0.40,  cachedInputPer1M: 0.10,  outputPer1M: 1.60 },
  "gpt-4.1-nano":      { inputPer1M: 0.10,  cachedInputPer1M: 0.025, outputPer1M: 0.40 },
  // o-series reasoning
  "o1":                { inputPer1M: 15.0,  cachedInputPer1M: 7.5,   outputPer1M: 60.0 },
  "o1-mini":           { inputPer1M: 3.0,   cachedInputPer1M: 1.5,   outputPer1M: 12.0 },
  "o3":                { inputPer1M: 2.0,   cachedInputPer1M: 0.50,  outputPer1M: 8.0 },
  "o3-mini":           { inputPer1M: 1.1,   cachedInputPer1M: 0.55,  outputPer1M: 4.4 },
  "o4-mini":           { inputPer1M: 1.1,   cachedInputPer1M: 0.275, outputPer1M: 4.4 },
};

function normalizeModelKey(model: string): string {
  return model.toLowerCase().trim();
}

/**
 * Resolve pricing for a deployment/model name using a longest-prefix match so
 * `gpt-4o-2024-08-06` matches `gpt-4o`.
 */
export function resolveModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const key = normalizeModelKey(model);
  if (TABLE[key]) return TABLE[key];
  let best: { keyLen: number; price: ModelPrice } | null = null;
  for (const [k, price] of Object.entries(TABLE)) {
    if (key.startsWith(k) && (!best || k.length > best.keyLen)) {
      best = { keyLen: k.length, price };
    }
  }
  return best?.price ?? null;
}

/**
 * Compute USD cost from token counts. Returns null when the model is unknown
 * so the caller can pass `costUsd: null` — Paperclip will still track token
 * counts and surface "model unknown to pricing table" rather than fake $0.
 */
export function computeCostUsd(
  model: string | null | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | null {
  const price = resolveModelPrice(model);
  if (!price) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = (uncachedInput / 1_000_000) * price.inputPer1M;
  const cachedCost = (cached / 1_000_000) * (price.cachedInputPer1M ?? price.inputPer1M);
  const outputCost = (usage.outputTokens / 1_000_000) * price.outputPer1M;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}
