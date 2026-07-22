// Source: https://api-docs.deepseek.com/quick_start/pricing
// Verified 2026-07-16. Update this single table when provider pricing changes.
export const DEEPSEEK_PRICING_USD_PER_MILLION = Object.freeze({
  "deepseek-v4-flash": Object.freeze({ cachedInput: 0.0028, input: 0.14, output: 0.28 }),
  "deepseek-v4-pro": Object.freeze({ cachedInput: 0.003625, input: 0.435, output: 0.87 }),
});

export function emptyDeepSeekMeter() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function normalizeDeepSeekUsage(usage) {
  const cachedInputTokens = nonNegativeInteger(usage?.prompt_cache_hit_tokens);
  const reportedPromptTokens = nonNegativeInteger(usage?.prompt_tokens);
  const reportedMissTokens = usage?.prompt_cache_miss_tokens;
  const inputTokens = reportedMissTokens == null
    ? Math.max(0, reportedPromptTokens - cachedInputTokens)
    : nonNegativeInteger(reportedMissTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: nonNegativeInteger(usage?.completion_tokens),
  };
}

export function calculateDeepSeekCostUsd(model, usage) {
  const rates = DEEPSEEK_PRICING_USD_PER_MILLION[model];
  if (!rates) return null;
  const normalized = normalizeDeepSeekUsage(usage);
  return (
    normalized.inputTokens * rates.input
    + normalized.cachedInputTokens * rates.cachedInput
    + normalized.outputTokens * rates.output
  ) / 1_000_000;
}

export function addDeepSeekUsage(meter, model, usage) {
  const normalized = normalizeDeepSeekUsage(usage);
  meter.inputTokens += normalized.inputTokens;
  meter.cachedInputTokens += normalized.cachedInputTokens;
  meter.outputTokens += normalized.outputTokens;
  const costUsd = calculateDeepSeekCostUsd(model, usage);
  if (costUsd != null) meter.costUsd += costUsd;
  return meter;
}
