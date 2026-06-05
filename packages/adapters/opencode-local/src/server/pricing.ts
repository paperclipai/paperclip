import type { AdapterCostSource } from "@paperclipai/adapter-utils";

// LIST-PRICE ESTIMATE TABLE — NOT metered billing.
//
// opencode does not populate `part.cost` for openai-compatible routes
// (LiteLLM / openai-direct), so we estimate cost = tokens × list price. Every
// figure derived from this table is flagged `costSource: "list_estimate"`
// (BLO-9102) so rollups never compare it against true metered cost as if equal.
//
// Coverage invariant (BLO-9102 acceptance #3): every model an opencode agent
// can be configured with — the `models` allowlist + `modelProfiles` in
// ../index.ts, plus any model observed in live run data — MUST appear here, or
// it silently reports costUsd=0. `openai/gpt-5.3-codex` was the observed $0
// hole that motivated this pass.
//
// RATE ACCURACY: values are best-effort. Where a version exists in LiteLLM's
// model_prices_and_context_window.json we anchor to it; otherwise we anchor to
// the nearest in-family sibling (see per-line notes). The gpt-5.x `openai/`
// versions below are largely ABSENT from LiteLLM as of 2026-06, so most rates
// remain UNVERIFIED estimates — wrong cents misattribute rollups but cannot
// break functionality (the fallback is informational and never gates a run).
// The `list_estimate` flag is precisely what makes a later rate re-verification
// auditable. Refresh policy: bump when LiteLLM's table or OpenAI's pricing page
// changes; re-verify all entries against LiteLLM and narrow the estimate set.
//
// Internal family ratio used for sibling-anchored estimates: cachedInput ≈
// input/10, output ≈ input×4 (matches the original BLO-7436 entries).
export const OPENAI_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  // --- Original BLO-7436 entries (unverified; LiteLLM azure_ai/ variants
  // suggest 5.4/5.4-mini output may be understated — flagged for re-verify). ---
  "openai/gpt-5.5": { input: 3.0, cachedInput: 0.3, output: 12.0 },
  "openai/gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 10.0 },
  "openai/gpt-5.4-mini": { input: 0.5, cachedInput: 0.05, output: 2.0 },
  "openai/gpt-5.2-codex": { input: 1.5, cachedInput: 0.15, output: 6.0 },
  // --- BLO-9102: in-use ∪ advertised models previously missing (→ $0). ---
  // gpt-5.3-codex: the observed $0 hole. Codex tier above 5.2-codex; anchored
  // just above the 5.2-codex sibling. UNVERIFIED estimate.
  "openai/gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 7.0 },
  // gpt-5.2 (non-codex base): advertised in index.ts models[]. Anchored below
  // the 5.4 base. UNVERIFIED estimate.
  "openai/gpt-5.2": { input: 2.0, cachedInput: 0.2, output: 8.0 },
  // gpt-5.1-codex-max: advertised "max" tier; anchored to the 5.4 base.
  // UNVERIFIED estimate.
  "openai/gpt-5.1-codex-max": { input: 2.5, cachedInput: 0.25, output: 10.0 },
  // gpt-5.1-codex-mini: the `modelProfiles` "Cheap" lane; anchored to the
  // 5.4-mini sibling. UNVERIFIED estimate.
  "openai/gpt-5.1-codex-mini": { input: 0.5, cachedInput: 0.05, output: 2.0 },
};

export function computeOpenAICompatibleCost(
  model: string | null,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number | null {
  if (!model) return null;
  const rate = OPENAI_PRICING_USD_PER_MTOK[model];
  if (!rate) return null;
  if (usage.inputTokens + usage.cachedInputTokens + usage.outputTokens === 0) return null;
  return (
    (usage.inputTokens * rate.input) / 1_000_000 +
    (usage.cachedInputTokens * rate.cachedInput) / 1_000_000 +
    (usage.outputTokens * rate.output) / 1_000_000
  );
}

/**
 * Classify the provenance of a run's cost figure (BLO-9102). Pure so it is unit
 * testable in isolation from the execute harness.
 *
 * @param parsedCostUsd  cost reported by opencode (`part.cost` sum); 0 when the
 *                       openai-compatible route did not populate it.
 * @param fallbackCost   result of {@link computeOpenAICompatibleCost}; non-null
 *                       only when we estimated from the list-price table.
 */
export function classifyCostSource(
  parsedCostUsd: number,
  fallbackCost: number | null,
): AdapterCostSource {
  if (fallbackCost !== null) return "list_estimate";
  if (parsedCostUsd > 0) return "metered";
  // costUsd 0 and nothing to estimate from: a zero-usage run, or an unpriced
  // model (the $0 hole the coverage invariant above is meant to eliminate).
  return "unknown";
}
