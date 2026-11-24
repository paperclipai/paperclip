export const MODEL_LIST_PRICES_VERSION = "list-prices-2026-11-24";
export const MODEL_LIST_PRICE_SOURCES = [
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://developers.openai.com/api/docs/pricing",
] as const;

export type ListPriceRates = readonly [input: string, cachedInput: string, cacheWrite: string, output: string];

export const MODEL_LIST_PRICES: Readonly<Record<string, ListPriceRates>> = {
  "claude-fable-5-2": ["8", "0.2", "16", "40"],
  "claude-opus-5-5": ["4", "0.2", "8", "20"],
  "claude-opus-5": ["5", "0.5", "10", "25"],
  "claude-sonnet-5-5": ["2", "0.1", "4", "10"],
  "claude-sonnet-5": ["2", "0.2", "4", "10"],
  "claude-sonnet-4-6": ["3", "0.3", "6", "15"],
  "claude-haiku-5-5": ["0.1", "0.01", "0.2", "0.5"],
  "claude-haiku-4-5": ["1", "0.1", "2", "5"],
  "gpt-6-astra": ["10", "1", "12.5", "50"],
  "gpt-6-sol": ["2", "0.2", "2.5", "10"],
  "gpt-6.1-sol": ["2", "0.1", "2.5", "10"],
  "gpt-6.1-terra": ["1", "0.05", "1.25", "5"],
  "gpt-6-luna": ["0.1", "0.01", "0.125", "0.5"],
  "gpt-5.6-sol": ["4", "0.4", "5", "20"],
};

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

export function resolveListPriceModel(model: string): string | null {
  const name = model.trim().toLowerCase()
    .replace(/^(anthropic|openai)\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  if (!name) return null;
  const resolved = Object.hasOwn(MODEL_ALIASES, name) ? MODEL_ALIASES[name] : name;
  return Object.hasOwn(MODEL_LIST_PRICES, resolved) ? resolved : null;
}

export interface ListPriceTokens {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
}

export function priceAtListPrice(model: string, tokens: ListPriceTokens): number | null {
  const key = resolveListPriceModel(model);
  if (!key) return null;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const counts = [tokens.inputTokens - cacheWrite, tokens.cachedInputTokens, cacheWrite, tokens.outputTokens];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return null;
  const rates = MODEL_LIST_PRICES[key];
  return counts.reduce((cents, count, index) => cents + (count * Number(rates[index])) / 10_000, 0);
}
