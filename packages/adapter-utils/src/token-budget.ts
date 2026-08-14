/**
 * Weighted per-run token-budget accounting.
 *
 * Cache READS bill at roughly a tenth of fresh input on every provider this
 * fleet runs (Anthropic 0.1x; OpenAI/xAI cached discounts comparable) and do
 * not drain subscription quota the way fresh input does. Counting them at
 * full weight made `maxTokensPerRun` charge turns x resident-context: a
 * healthy 25-turn run with a ~30K instruction/skill context measured ~360K
 * "observed" while consuming ~30K fresh input, so leadership lanes walled at
 * 100K/200K/400K mid-report (TSMC-20840, 2026-08-14). Cache WRITES stay at
 * full weight (they bill at or above fresh input).
 */
export const CACHED_INPUT_BUDGET_WEIGHT = 0.1;

export function weightedBudgetTokens(parts: {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  cachedWriteTokens?: number | null;
  thoughtTokens?: number | null;
}): number {
  const n = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return Math.max(
    0,
    Math.floor(
      n(parts.inputTokens) +
        n(parts.outputTokens) +
        n(parts.cachedWriteTokens) +
        n(parts.thoughtTokens) +
        CACHED_INPUT_BUDGET_WEIGHT * n(parts.cachedInputTokens),
    ),
  );
}
