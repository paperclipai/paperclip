import type { AdapterBillingType, UsageSummary } from "@paperclipai/adapter-utils";

type GatewayAttribution = {
  provider: string;
  biller: string;
  billingType: AdapterBillingType;
};

const DEEPSEEK_PRICES_PER_MILLION: Record<string, { input: number; cachedInput: number; output: number }> = {
  "deepseek-v4-pro": { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  "deepseek-chat": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
};

const DEEPSEEK_FALLBACK_PRICE = { input: 1, cachedInput: 0.1, output: 3 };
const MIMO_USD_PER_MILLION_TOKENS = 1.0;

export function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

export function isDeepSeekGateway(env: Record<string, string>): boolean {
  const base = (env.ANTHROPIC_BASE_URL ?? "").toLowerCase();
  return base.includes("api.deepseek.com") || base.includes("deepseek.com/anthropic");
}

export function isMimoGateway(env: Record<string, string>): boolean {
  return (env.ANTHROPIC_BASE_URL ?? "").toLowerCase().includes("xiaomimimo.com");
}

/**
 * Detect a third-party Anthropic-compatible gateway (DeepSeek `/anthropic`,
 * Xiaomi MiMo `/anthropic`, LiteLLM, etc.) - i.e. an ANTHROPIC_BASE_URL that is
 * not Anthropic's own host. On these gateways the upstream model ids are the
 * provider's (`deepseek-*`, `mimo-*`), not `claude-*`.
 */
export function isThirdPartyAnthropicGateway(env: Record<string, string>): boolean {
  const base = (env.ANTHROPIC_BASE_URL ?? "").trim().toLowerCase();
  if (!base) return false;
  return !/(^https?:\/\/)?([a-z0-9-]+\.)*anthropic\.com(\/|$)/.test(base);
}

export function resolveClaudeGatewayAttribution(env: Record<string, string>): GatewayAttribution {
  if (isDeepSeekGateway(env)) {
    return { provider: "deepseek", biller: "deepseek", billingType: "api" };
  }
  if (isMimoGateway(env)) {
    return { provider: "mimo", biller: "mimo", billingType: "credits" };
  }
  if (isBedrockAuth(env)) {
    return { provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" };
  }
  return {
    provider: "anthropic",
    biller: "anthropic",
    billingType: hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription",
  };
}

/**
 * When pointed at a third-party gateway, a `claude-*` model id selected in the
 * agent's Model dropdown would be sent verbatim and rejected or mis-attributed.
 * Translate such an id to the gateway's configured tier model.
 */
export function resolveGatewayModelOverride(model: string, env: Record<string, string>): string | null {
  if (!model || !isThirdPartyAnthropicGateway(env)) return null;
  const lower = model.toLowerCase();
  if (!lower.startsWith("claude-")) return null;
  const pick = (key: string) => {
    const value = (env[key] ?? "").trim();
    return value.length > 0 ? value : null;
  };
  if (lower.startsWith("claude-opus")) {
    return pick("ANTHROPIC_DEFAULT_OPUS_MODEL") ?? pick("ANTHROPIC_MODEL");
  }
  if (lower.startsWith("claude-haiku")) {
    return pick("ANTHROPIC_DEFAULT_HAIKU_MODEL") ?? pick("ANTHROPIC_MODEL");
  }
  return pick("ANTHROPIC_DEFAULT_SONNET_MODEL") ?? pick("ANTHROPIC_MODEL");
}

function readGatewayDefaultModel(env: Record<string, string>): string | null {
  if (!isThirdPartyAnthropicGateway(env)) return null;
  const model = (env.ANTHROPIC_MODEL ?? "").trim();
  return model.length > 0 ? model : null;
}

export function resolveGatewayReportedModel(input: {
  env: Record<string, string>;
  configuredModel: string;
  parsedModel: string | null;
}): string {
  const fallback =
    resolveGatewayModelOverride(input.configuredModel, input.env) ??
    readGatewayDefaultModel(input.env) ??
    (input.configuredModel.trim().length > 0 ? input.configuredModel.trim() : "unknown");
  const parsed = input.parsedModel?.trim() ?? "";
  if (!parsed) return fallback;
  if (isThirdPartyAnthropicGateway(input.env) && parsed.toLowerCase().startsWith("claude-")) {
    return fallback;
  }
  return parsed;
}

function normalizeCostUsd(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateMimoCostUsd(usage: UsageSummary): number {
  const total =
    Math.max(0, usage.inputTokens ?? 0) +
    Math.max(0, usage.cachedInputTokens ?? 0) +
    Math.max(0, usage.outputTokens ?? 0);
  return (total * MIMO_USD_PER_MILLION_TOKENS) / 1_000_000;
}

function deepSeekPriceForModel(model: string) {
  const normalized = model.trim().toLowerCase();
  if (DEEPSEEK_PRICES_PER_MILLION[normalized]) return DEEPSEEK_PRICES_PER_MILLION[normalized];
  if (normalized.includes("deepseek-v4-pro")) return DEEPSEEK_PRICES_PER_MILLION["deepseek-v4-pro"];
  if (normalized.includes("deepseek-v4-flash")) return DEEPSEEK_PRICES_PER_MILLION["deepseek-v4-flash"];
  return DEEPSEEK_FALLBACK_PRICE;
}

function estimateDeepSeekCostUsd(model: string, usage: UsageSummary): number {
  const price = deepSeekPriceForModel(model);
  return (
    (Math.max(0, usage.inputTokens ?? 0) * price.input +
      Math.max(0, usage.cachedInputTokens ?? 0) * price.cachedInput +
      Math.max(0, usage.outputTokens ?? 0) * price.output) /
    1_000_000
  );
}

export function resolveGatewayCostUsd(input: {
  env: Record<string, string>;
  model: string;
  usage: UsageSummary;
  cliCostUsd: number | null | undefined;
}): number {
  if (isMimoGateway(input.env)) return estimateMimoCostUsd(input.usage);
  if (isDeepSeekGateway(input.env)) return estimateDeepSeekCostUsd(input.model, input.usage);
  return normalizeCostUsd(input.cliCostUsd);
}
