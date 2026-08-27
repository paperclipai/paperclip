import type { UsageSummary } from "@paperclipai/adapter-utils";
import { DEFAULT_CODEBUDDY_LOCAL_MODEL } from "../index.js";

/**
 * LOCAL-ONLY CUSTOMIZATION (do not upstream as-is):
 *
 * CodeBuddy CLI runs under a flat-fee subscription, so its own
 * `total_cost_usd` is typically null/0, and this adapter historically
 * reported `billingType: "subscription_included"`. The Paperclip server
 * always bills that billing type as $0 regardless of token usage
 * (see `normalizeBilledCostCents` in `server/src/services/heartbeat.ts`),
 * which meant Budget/Spend dashboards showed 0 for CodeBuddy agents even
 * though real token usage (and real underlying inference cost) was non-trivial.
 *
 * To surface a meaningful spend estimate in Paperclip's Budget UI, we
 * approximate a per-token cost based on the underlying model CodeBuddy is
 * proxying to, and report the run as `metered_api` so the server actually
 * sums the estimated cost into `cost_events.costCents`.
 *
 * Prices below are USD per 1,000,000 tokens and are ROUGH ESTIMATES based on
 * public pricing for comparable models. Adjust `PRICING_TABLE` /
 * `DEFAULT_PRICING` to match your actual plan if you want more accurate
 * numbers. This does not charge you anything extra — it only changes what
 * Paperclip *displays* as estimated spend.
 */
export interface CodeBuddyModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_TABLE: Record<string, CodeBuddyModelPricing> = {
  "gemini-3.0-pro": { inputPerMillion: 2.5, cachedInputPerMillion: 0.625, outputPerMillion: 10 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, cachedInputPerMillion: 0.31, outputPerMillion: 10 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, cachedInputPerMillion: 0.075, outputPerMillion: 2.5 },
  "gpt-5.1": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  "gpt-5.5": { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
};

/** Used when the model id is unknown or is the generic "default-model". */
const DEFAULT_PRICING: CodeBuddyModelPricing = {
  inputPerMillion: 1.25,
  cachedInputPerMillion: 0.31,
  outputPerMillion: 10,
};

export function resolveCodeBuddyPricing(model: string): CodeBuddyModelPricing {
  const key = (model || "").trim().toLowerCase();
  if (!key || key === DEFAULT_CODEBUDDY_LOCAL_MODEL) return DEFAULT_PRICING;
  return PRICING_TABLE[key] ?? DEFAULT_PRICING;
}

/**
 * Estimates a USD cost from token usage. Returns null when there is no
 * usage to price (e.g. a run that produced no billable tokens), so callers
 * can fall back to `subscription_included` (billed as $0) in that case.
 */
export function estimateCodeBuddyCostUsd(
  model: string,
  usage: UsageSummary | null | undefined,
): number | null {
  if (!usage) return null;
  const pricing = resolveCodeBuddyPricing(model);
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return null;
  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Number.isFinite(cost) ? cost : null;
}
