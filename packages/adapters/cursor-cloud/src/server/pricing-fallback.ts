import type { CursorRunUsage } from "./usage.js";

/** USD per 1M tokens — heuristic; not authoritative Cursor billing. */
const CURSOR_MODEL_PRICING: Record<
  string,
  { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }
> = {
  "gpt-5.4": { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.25 },
  "gpt-5": { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.25 },
  "composer-2.5": { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.2 },
  "composer-2": { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.2 },
  "claude-4-sonnet": { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 },
  "claude-4-opus": { inputUsdPerMillion: 15, outputUsdPerMillion: 75, cachedInputUsdPerMillion: 1.5 },
  auto: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 },
};

function normalizeModelKey(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  if (trimmed in CURSOR_MODEL_PRICING) return trimmed;
  for (const key of Object.keys(CURSOR_MODEL_PRICING)) {
    if (trimmed.includes(key)) return key;
  }
  return "auto";
}

export function estimateCursorCloudCostUsd(input: {
  modelId: string | null | undefined;
  usage: CursorRunUsage;
}): number | null {
  if (input.usage.totalTokens <= 0) return null;
  const key = normalizeModelKey(input.modelId ?? "auto");
  const rates = CURSOR_MODEL_PRICING[key] ?? CURSOR_MODEL_PRICING.auto;
  const cachedRate = rates.cachedInputUsdPerMillion ?? rates.inputUsdPerMillion * 0.1;
  const inputUsd = (input.usage.inputTokens / 1_000_000) * rates.inputUsdPerMillion;
  const cachedUsd = (input.usage.cacheReadTokens / 1_000_000) * cachedRate;
  const outputUsd = (input.usage.outputTokens / 1_000_000) * rates.outputUsdPerMillion;
  const total = inputUsd + cachedUsd + outputUsd;
  return total > 0 ? Math.round(total * 1_000_000) / 1_000_000 : null;
}
