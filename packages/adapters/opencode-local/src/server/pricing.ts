// TODO(BLO-7436): VERIFY these rates against openai.com/pricing before merging.
// Values below are conservative estimates as of the 2026-01 knowledge cutoff;
// gpt-5.x family pricing has shifted since launch. Wrong values produce
// misattributed cost rollups but cannot break functionality — the fallback
// is purely informational and never gates a run.
//
// Refresh policy: bump whenever LiteLLM's model_prices_and_context_window.json
// or OpenAI's pricing page changes. Track in CHANGELOG.
export const OPENAI_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "openai/gpt-5.5": { input: 3.0, cachedInput: 0.3, output: 12.0 },
  "openai/gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 10.0 },
  "openai/gpt-5.4-mini": { input: 0.5, cachedInput: 0.05, output: 2.0 },
  "openai/gpt-5.2-codex": { input: 1.5, cachedInput: 0.15, output: 6.0 },
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
