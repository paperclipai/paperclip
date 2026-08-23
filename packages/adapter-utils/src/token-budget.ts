/**
 * Weighted per-run token-budget accounting.
 *
 * Cache READS are the SAME resident context (instructions, skills, prior turns)
 * re-read on every turn; they are bounded by the run's turn cap, not by new work,
 * and barely drain subscription quota. The per-run governor exists to stop ONE
 * run generating a large amount of NEW work — fresh input + cache CREATION +
 * output — so cache reads carry a near-zero weight here.
 *
 * History: full weight charged turns x resident-context (TMSC-20840, 2026-08-14);
 * 0.1x helped but a deep, efficient run still walled — measured 2026-08-23:
 * a 34-turn claude verdict consumed 58 fresh input + 26K output + 92K cache
 * creation (~118K real) yet read 2.93M from cache, so 0.1x = 293K tipped the
 * 400K cap and killed a run that cost almost nothing. 0.02x keeps a bound on
 * pathological re-read loops (turn cap x resident stays well under budget) while
 * letting deep cached work complete. Cache WRITES stay at full weight (real cost),
 * so context CHURN still trips the budget. The 1M aggregate-input ceiling
 * (raw, cache included) remains the issue-level runaway backstop.
 */
export const CACHED_INPUT_BUDGET_WEIGHT = 0.02;

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
