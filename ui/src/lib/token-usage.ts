/**
 * Token-usage presentation for deployments where spend cannot be reported.
 *
 * `normalizeBilledCostCents` forces `costCents` to 0 for `subscription_included`
 * runs, so on such deployments every money figure is permanently $0.00 no matter
 * how much the fleet consumed. Token counts are recorded in full on the same
 * rows, so they are what the UI shows instead.
 *
 * Formatting of a single count lives in `./utils` (`formatTokens`); this module
 * only adds the weighting and breakdown that spend-less deployments need.
 */
import { formatTokens } from "./utils";

/**
 * Relative weights for a single comparable usage number.
 *
 * Cached input reads are roughly an order of magnitude cheaper than fresh input,
 * and output is several times dearer. These are deliberately coarse: the figure
 * exists to be compared against itself over time and against a generous cap, not
 * to reconstruct a bill. Raw totals are unusable for that purpose because cached
 * input dominates volume (~96% observed), so an unweighted sum mostly measures
 * context size rather than work done.
 */
export const TOKEN_WEIGHTS = { input: 1, cachedInput: 0.1, output: 5 } as const;

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/** Single comparable usage figure. See TOKEN_WEIGHTS for why it is weighted. */
export function weightedTokens(usage: TokenUsage): number {
  return Math.round(
    usage.inputTokens * TOKEN_WEIGHTS.input +
      usage.cachedInputTokens * TOKEN_WEIGHTS.cachedInput +
      usage.outputTokens * TOKEN_WEIGHTS.output,
  );
}

export function hasTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.outputTokens > 0
  );
}

/** Full breakdown for a tile subtitle or tooltip. */
export function formatTokenBreakdown(usage: TokenUsage): string {
  return (
    `${formatTokens(usage.inputTokens)} in · ` +
    `${formatTokens(usage.cachedInputTokens)} cached · ` +
    `${formatTokens(usage.outputTokens)} out`
  );
}

/**
 * Label for a monthly budget line.
 *
 * The subscription case is checked before the budget value on purpose. When
 * every run is `subscription_included`, `costCents` is always 0, so a cents
 * budget can never be consumed and can never fire. A configured budget is
 * therefore at least as misleading as an absent one — it looks active. A budget
 * of 0 is likewise "not set" rather than "unlimited by design".
 */
export function budgetLabel(input: {
  budgetCents: number | null | undefined;
  subscriptionOnlyBilling: boolean;
  formatCents: (cents: number) => string;
}): string {
  const hasBudget = typeof input.budgetCents === "number" && input.budgetCents > 0;
  if (input.subscriptionOnlyBilling) {
    return hasBudget
      ? `Budget ${input.formatCents(input.budgetCents as number)} — not enforceable on subscription billing`
      : "Budget not enforceable on subscription billing";
  }
  return hasBudget ? `Budget ${input.formatCents(input.budgetCents as number)}` : "Unlimited budget";
}

/**
 * Whether a cents budget can actually be enforced.
 *
 * A budget needs both a positive amount and a billing mode that produces
 * non-zero `costCents`. On subscription-only billing the spend it measures is
 * structurally zero, so utilization is always 0% and every threshold reads
 * healthy forever. Any UI that shows utilization, a progress bar, a
 * "$X of $Y" pace, or a threshold colour must gate on this rather than on the
 * budget amount alone, or it contradicts the "not enforceable" label.
 */
export function budgetIsEnforceable(input: {
  budgetCents: number | null | undefined;
  subscriptionOnlyBilling: boolean;
}): boolean {
  if (input.subscriptionOnlyBilling) return false;
  return typeof input.budgetCents === "number" && input.budgetCents > 0;
}
