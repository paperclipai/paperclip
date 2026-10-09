/** Optional versioned PRP price authority. Absence preserves legacy unknown cost. */
export interface ProviderUsageBilling {
  schema: "paperclip.usage.billing/v1";
  source: "provider_reported";
  biller: "openrouter";
  currency: "USD";
  complete: boolean;
  requestCount: number;
  reportedRequestCount: number;
  amountUsd: number;
  amountUsdExact: string;
}

export function parseProviderUsageBilling(value: unknown): ProviderUsageBilling {
  const invalid = (): never => { throw new Error("Invalid provider billing receipt"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(key => !["schema", "source", "biller", "currency", "complete", "requestCount", "reportedRequestCount", "amountUsd", "amountUsdExact"].includes(key))
    || r.schema !== "paperclip.usage.billing/v1" || r.source !== "provider_reported" || r.biller !== "openrouter"
    || r.currency !== "USD" || typeof r.complete !== "boolean"
    || typeof r.requestCount !== "number" || !Number.isSafeInteger(r.requestCount) || r.requestCount < 0
    || typeof r.reportedRequestCount !== "number" || !Number.isSafeInteger(r.reportedRequestCount) || r.reportedRequestCount < 0
    || r.reportedRequestCount > r.requestCount || (r.complete && r.reportedRequestCount !== r.requestCount)
    || typeof r.amountUsd !== "number" || !Number.isFinite(r.amountUsd) || r.amountUsd < 0 || r.amountUsd > 1_000_000
    || typeof r.amountUsdExact !== "string" || !/^(0|[1-9][0-9]{0,6})\.[0-9]{9}$/.test(r.amountUsdExact)
    || Number(r.amountUsdExact) !== r.amountUsd
    || (r.reportedRequestCount === 0 && r.amountUsd !== 0)) invalid();
  return { ...r } as unknown as ProviderUsageBilling;
}

export function readProviderUsageBilling(value: unknown): ProviderUsageBilling | null {
  try { return parseProviderUsageBilling(value); } catch { return null; }
}
