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
