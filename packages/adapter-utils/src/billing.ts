function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const TOKENS_PER_MILLION = 1_000_000;

type TokenPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

const OPENAI_MODEL_PRICING: Record<string, TokenPricing> = {
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.3-codex-spark": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5-mini": { inputUsdPerMillion: 0.25, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
  "gpt-5-nano": { inputUsdPerMillion: 0.05, cachedInputUsdPerMillion: 0.005, outputUsdPerMillion: 0.4 },
  o3: { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 },
  "o4-mini": { inputUsdPerMillion: 1.1, cachedInputUsdPerMillion: 0.275, outputUsdPerMillion: 4.4 },
  "codex-mini-latest": { inputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.375, outputUsdPerMillion: 6 },
};

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

function normalizeProvider(provider: string | null | undefined): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function normalizeModel(model: string | null | undefined): string {
  return typeof model === "string" ? model.trim().toLowerCase() : "";
}

function resolveAnthropicPricing(model: string): TokenPricing | null {
  if (model.includes("fable-5") || model.includes("mythos-5")) {
    return { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 };
  }
  if (/opus[-_\s.]*4[-_\s.]*1/.test(model)) {
    return { inputUsdPerMillion: 15, cachedInputUsdPerMillion: 1.5, outputUsdPerMillion: 75 };
  }
  if (/opus[-_\s.]*4[-_\s.]*[5678]/.test(model) || /opus[-_\s.]*4(?:[-_\s.]|$)/.test(model)) {
    return { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25 };
  }
  if (/sonnet[-_\s.]*4/.test(model)) {
    return { inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3, outputUsdPerMillion: 15 };
  }
  if (/haiku[-_\s.]*4[-_\s.]*5/.test(model)) {
    return { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 5 };
  }
  return null;
}

function resolveTokenPricing(provider: string | null | undefined, model: string | null | undefined): TokenPricing | null {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModel(model);
  if (!normalizedProvider || !normalizedModel) return null;

  if (normalizedProvider === "openai") {
    return OPENAI_MODEL_PRICING[normalizedModel] ?? null;
  }

  if (normalizedProvider === "anthropic") {
    return resolveAnthropicPricing(normalizedModel);
  }

  return null;
}

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function estimateTokenMarketValueUsd(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  inputTokens: number;
  cachedInputTokens?: number | null;
  outputTokens: number;
}): number | null {
  const pricing = resolveTokenPricing(input.provider, input.model);
  if (!pricing) return null;

  const total =
    (normalizeTokenCount(input.inputTokens) * pricing.inputUsdPerMillion +
      normalizeTokenCount(input.cachedInputTokens) * pricing.cachedInputUsdPerMillion +
      normalizeTokenCount(input.outputTokens) * pricing.outputUsdPerMillion) /
    TOKENS_PER_MILLION;

  return Number(total.toFixed(8));
}

export function estimateTokenMarketValueCents(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  inputTokens: number;
  cachedInputTokens?: number | null;
  outputTokens: number;
}): number | null {
  const usd = estimateTokenMarketValueUsd(input);
  return usd === null ? null : Math.max(0, Math.round(usd * 100));
}
