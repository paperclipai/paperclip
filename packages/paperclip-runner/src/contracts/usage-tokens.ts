/** Complete direct API attempt counts permit a rate-card estimate, never an invoice claim. */
export interface ProviderTokenAccounting {
  schema: "paperclip.usage.tokens/v1";
  source: "provider_wire";
  biller: "anthropic" | "openai";
  model: string;
  protocol: "messages" | "chat_completions" | "responses";
  complete: boolean;
  requestCount: number;
  reportedRequestCount: number;
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  pricingContext: { serviceTier: "standard"; contextTier: "short" };
}

export function parseProviderTokenAccounting(value: unknown): ProviderTokenAccounting {
  const invalid = (): never => { throw new Error("Invalid provider token accounting receipt"); };
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
  const r = object(value), tokens = object(r.tokens), pricing = object(r.pricingContext);
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (Object.keys(r).length !== 10 || r.schema !== "paperclip.usage.tokens/v1" || r.source !== "provider_wire"
    || (r.biller !== "anthropic" && r.biller !== "openai") || typeof r.model !== "string" || !r.model.trim() || r.model.length > 240
    || (r.biller === "anthropic" ? r.protocol !== "messages" : r.protocol !== "responses" && r.protocol !== "chat_completions")
    || typeof r.complete !== "boolean" || !count(r.requestCount) || !count(r.reportedRequestCount)
    || r.reportedRequestCount > r.requestCount || (r.complete && r.reportedRequestCount !== r.requestCount)
    || Object.keys(tokens).length !== 4 || !["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every(key => count(tokens[key]))
    || !Number.isSafeInteger(Object.values(tokens).reduce<number>((sum, v) => sum + Number(v), 0))
    || (r.reportedRequestCount === 0 && Object.values(tokens).some(v => v !== 0))
    || Object.keys(pricing).length !== 2 || pricing.serviceTier !== "standard" || pricing.contextTier !== "short") invalid();
  return structuredClone(r) as unknown as ProviderTokenAccounting;
}

export function readProviderTokenAccounting(value: unknown): ProviderTokenAccounting | null {
  try { return parseProviderTokenAccounting(value); } catch { return null; }
}
