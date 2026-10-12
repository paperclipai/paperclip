import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

// Immutable, reviewed rate card. Existing receipts retain their selected rates.
// https://api-docs.deepseek.com/quick_start/pricing (retrieved 2026-10-08)
// Rates are USD per 1M tokens, given off-peak (the cheaper half of the day).
// Peak hours (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) bill at 2x. The peak
// multiplier is applied at capture time from the wall clock; Chinese public
// holidays are not modeled, so a holiday weekday inside a peak window is
// slightly over-estimated.
const VERSION = "deepseek-standard-2026-10-08";
// [cache-miss input, cache-hit input, cache-write, output] USD per 1M tokens.
const RATES: Record<string, readonly [string, string, string, string]> = {
  "deepseek-flash": ["0.15", "0.003", "0", "0.6"],
  "deepseek-v4-pro": ["0.66", "0.022", "0", "1.98"],
};

/** DeepSeek peak windows: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
export function isDeepSeekPeak(now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Strip the Paperclip projection prefix (`paperclip/deepseek-flash`) and any
 * window suffix (`deepseek-flash[1m]`) down to the DeepSeek model id. */
function normalizeDeepSeekModel(model: string): string {
  const withoutProvider = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return withoutProvider.replace(/\[[^\]]*\]$/, "").trim().toLowerCase();
}

/**
 * Only a native DeepSeek connection may be priced by this card.
 *
 * The model id alone is not enough: OpenRouter, a custom gateway, or a local
 * OpenAI-compatible endpoint can serve the same DeepSeek model id at different
 * (or zero) rates. Provider/biller labels are not enough either, because each
 * harness reports its own (`paperclip` on OpenCode, `openai`/`unknown` on Codex,
 * `anthropic` on Claude). The server therefore passes the connection's routing
 * descriptor, which the projection already synthesizes as `kind: "deepseek"`.
 */
function isNativeDeepSeekRoute(routing: unknown): boolean {
  return typeof routing === "object" && routing !== null && (routing as { kind?: unknown }).kind === "deepseek";
}

/**
 * Price new DeepSeek receipts that the harness left unpriced.
 *
 * The projected provider (an `@ai-sdk/openai-compatible` provider pointed at
 * api.deepseek.com, or the `paperclip` Codex stanza) is not a models.dev
 * provider, so the harness emits cost 0 / unknown. This card fills that gap on
 * the server so budget and spend work. A real provider-reported cost always
 * wins.
 */
export function priceDeepSeekReceipt(
  receipt: AdapterUsageCheckpoint,
  now: Date = new Date(),
  routing?: unknown,
): AdapterUsageCheckpoint {
  if (
    !isNativeDeepSeekRoute(routing) ||
    !receipt.complete ||
    !receipt.usage ||
    receipt.usageBasis !== "per_run" ||
    receipt.usageByModel?.length ||
    receipt.billingType === "subscription_included" ||
    receipt.billingType === "subscription" ||
    receipt.costUsdExact != null ||
    receipt.cacheAdjustedCostUsd != null ||
    (typeof receipt.costUsd === "number" && receipt.costUsd > 0)
  )
    return receipt;
  const model = normalizeDeepSeekModel(receipt.model ?? "");
  const rates = Object.hasOwn(RATES, model) ? RATES[model] : undefined;
  if (!rates) return receipt;
  const usage = receipt.usage;
  const counts = [
    usage.inputTokens - (usage.cacheWriteTokens ?? 0),
    usage.cachedInputTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.outputTokens,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return receipt;
  const peak = isDeepSeekPeak(now);
  const peakMultiplier = peak ? 2n : 1n;
  const units = counts.reduce(
    (total, count, index) =>
      total + BigInt(count) * usdToUnits(rates[index]) * peakMultiplier,
    0n,
  );
  const costCents = unitsToCents((units + 500_000n) / 1_000_000n);
  const rate = (usd: string) =>
    unitsToCents(usdToUnits(usd) * peakMultiplier);
  return {
    ...receipt,
    costUsdExact: centsToUsd(costCents),
    costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card",
      version: VERSION,
      evidence: `https://api-docs.deepseek.com/quick_start/pricing; ${peak ? "peak" : "off-peak"} direct-API list price; token-price estimate, not an invoice; Chinese holidays not modeled`,
      inputCentsPerMillion: rate(rates[0]),
      cachedInputCentsPerMillion: rate(rates[1]),
      cacheWriteCentsPerMillion: rate(rates[2]),
      outputCentsPerMillion: rate(rates[3]),
      serviceTier: peak ? "peak" : "off-peak",
    },
  };
}
