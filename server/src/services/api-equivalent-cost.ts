type PricingRate = {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
  label: string;
};

type EstimateInput = {
  provider: string | null;
  biller: string | null;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  fallbackCostCents?: number;
};

export type ApiEquivalentCostEstimate = {
  costCents: number;
  source: "model_pricing" | "recorded_cost" | "none";
  pricingLabel: string | null;
};

export function isSubscriptionBillingType(value: string | null | undefined): boolean {
  return value === "subscription_included" || value === "subscription_overage" || value === "subscription";
}

export function estimateApiEquivalentCostCents(input: EstimateInput): ApiEquivalentCostEstimate {
  const rate = resolvePricingRate(input.provider, input.biller, input.model);
  if (!rate) {
    const fallback = Math.max(0, Math.round(input.fallbackCostCents ?? 0));
    return fallback > 0
      ? { costCents: fallback, source: "recorded_cost", pricingLabel: null }
      : { costCents: 0, source: "none", pricingLabel: null };
  }

  const costUsd =
    (Math.max(0, input.inputTokens) / 1_000_000) * rate.inputPerMillionUsd
    + (Math.max(0, input.cachedInputTokens) / 1_000_000) * rate.cachedInputPerMillionUsd
    + (Math.max(0, input.outputTokens) / 1_000_000) * rate.outputPerMillionUsd;

  return {
    costCents: Math.max(0, Math.round(costUsd * 100)),
    source: "model_pricing",
    pricingLabel: rate.label,
  };
}

function resolvePricingRate(provider: string | null, biller: string | null, model: string | null): PricingRate | null {
  const normalizedProvider = normalize(provider);
  const normalizedBiller = normalize(biller);
  const normalizedModel = normalize(model);

  if (normalizedProvider.includes("mimo") || normalizedBiller.includes("mimo") || normalizedModel.includes("mimo")) {
    return {
      inputPerMillionUsd: 1,
      cachedInputPerMillionUsd: 1,
      outputPerMillionUsd: 1,
      label: "MiMo token-plan equivalent",
    };
  }

  if (
    normalizedProvider.includes("anthropic")
    || normalizedProvider.includes("claude")
    || normalizedBiller.includes("anthropic")
    || normalizedBiller.includes("claude")
    || normalizedModel.includes("claude")
  ) {
    return resolveClaudePricingRate(normalizedModel);
  }

  if (
    normalizedProvider.includes("openai")
    || normalizedProvider.includes("chatgpt")
    || normalizedBiller.includes("openai")
    || normalizedBiller.includes("chatgpt")
    || normalizedModel.startsWith("gpt-")
    || normalizedModel.includes("codex")
  ) {
    return resolveOpenAiPricingRate(normalizedModel);
  }

  if (normalizedProvider.includes("deepseek") || normalizedBiller.includes("deepseek") || normalizedModel.includes("deepseek")) {
    return {
      inputPerMillionUsd: 1,
      cachedInputPerMillionUsd: 0.1,
      outputPerMillionUsd: 3,
      label: "DeepSeek API-equivalent fallback",
    };
  }

  if (normalizedProvider.includes("google") || normalizedBiller.includes("google") || normalizedModel.includes("gemini")) {
    return {
      inputPerMillionUsd: 1.25,
      cachedInputPerMillionUsd: 0.31,
      outputPerMillionUsd: 10,
      label: "Gemini API-equivalent fallback",
    };
  }

  return null;
}

function resolveClaudePricingRate(model: string): PricingRate {
  if (model.includes("opus-4-8")) {
    return claudeRate("Claude Opus 4.8 API-equivalent", 5, 25);
  }
  if (model.includes("opus-4-7") || model.includes("opus-4-6") || model.includes("opus-4-5")) {
    return claudeRate("Claude Opus 4.5-4.7 API-equivalent", 5, 25);
  }
  if (model.includes("opus-4-1") || model.includes("opus-4") || model.includes("opus")) {
    return claudeRate("Claude Opus API-equivalent", 15, 75);
  }
  if (model.includes("haiku-4-5") || model.includes("haiku")) {
    return claudeRate("Claude Haiku API-equivalent", 1, 5);
  }
  if (model.includes("sonnet")) {
    return claudeRate("Claude Sonnet API-equivalent", 3, 15);
  }
  return claudeRate("Claude Sonnet API-equivalent fallback", 3, 15);
}

function resolveOpenAiPricingRate(model: string): PricingRate {
  if (model.includes("gpt-5.3-codex") || model.includes("codex")) {
    return openAiRate("GPT-5.3 Codex API-equivalent", 1.75, 0.175, 14);
  }
  if (model.includes("chat-latest")) {
    return openAiRate("ChatGPT chat-latest API-equivalent", 5, 0.5, 30);
  }
  if (model.includes("gpt-5.5-pro") || model.includes("gpt-5.4-pro")) {
    return openAiRate("OpenAI pro model API-equivalent", 30, 3, 180);
  }
  if (model.includes("gpt-5.5")) {
    return openAiRate("GPT-5.5 API-equivalent", 5, 0.5, 30);
  }
  if (model.includes("gpt-5.4-mini") || model.includes("gpt-5-mini")) {
    return openAiRate("OpenAI mini model API-equivalent", 0.75, 0.075, 4.5);
  }
  if (model.includes("gpt-5.4-nano")) {
    return openAiRate("OpenAI nano model API-equivalent", 0.2, 0.02, 1.25);
  }
  if (model.includes("gpt-5.4") || model.includes("gpt-5")) {
    return openAiRate("OpenAI flagship API-equivalent fallback", 2.5, 0.25, 15);
  }
  return openAiRate("OpenAI API-equivalent fallback", 2.5, 0.25, 15);
}

function claudeRate(label: string, inputPerMillionUsd: number, outputPerMillionUsd: number): PricingRate {
  return {
    inputPerMillionUsd,
    cachedInputPerMillionUsd: inputPerMillionUsd * 0.1,
    outputPerMillionUsd,
    label,
  };
}

function openAiRate(
  label: string,
  inputPerMillionUsd: number,
  cachedInputPerMillionUsd: number,
  outputPerMillionUsd: number,
): PricingRate {
  return { inputPerMillionUsd, cachedInputPerMillionUsd, outputPerMillionUsd, label };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
