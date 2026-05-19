/**
 * Phase 4A-S4 B2 (LET-367): pure cap-threshold policy.
 *
 * Mirrors S3 §3 thresholds for the E2B pilot. Pure module — no I/O, no clock
 * reads. Callers pass in current spend + window kind; the policy returns the
 * structured decision the monitor uses to drive notifier + persistence.
 */

/** All amounts are USD cents. */
export interface BillingCapThresholds {
  /** Daily soft cap (USD 7.00 default — 50% of S3 day hard, half the monthly hard / 10). */
  daySoftCents: number;
  /** Daily hard cap (USD 10.00 default — 10% of the monthly hard cap). */
  dayHardCents: number;
  /** Monthly soft cap (USD 75.00 default — 75% of the trial-credit-aligned hard cap). */
  monthSoftCents: number;
  /** Monthly hard cap (USD 100.00 default — aligned with the E2B trial credit ceiling). */
  monthHardCents: number;
}

// Aligned with E2B $100 trial credit per LET-365 comment `98c7828f`.
export const E2B_PILOT_THRESHOLDS: Readonly<BillingCapThresholds> = Object.freeze({
  daySoftCents: 7_00,
  dayHardCents: 10_00,
  monthSoftCents: 75_00,
  monthHardCents: 100_00,
});

export type CapTier = "within" | "soft" | "hard";
export type WindowKind = "day" | "month";

export interface CapEvaluation {
  windowKind: WindowKind;
  /** Cap tier classification for this window's current spend. */
  tier: CapTier;
  /** The threshold that classifies this tier, in cents. `null` for `within`. */
  thresholdCents: number | null;
  /** Cumulative spend used to classify the tier, in cents. */
  spentCents: number;
}

export function evaluateWindow(
  windowKind: WindowKind,
  spentCents: number,
  thresholds: BillingCapThresholds,
): CapEvaluation {
  const safeSpent = Math.max(0, Math.trunc(spentCents));
  if (windowKind === "day") {
    if (safeSpent >= thresholds.dayHardCents) {
      return { windowKind, tier: "hard", thresholdCents: thresholds.dayHardCents, spentCents: safeSpent };
    }
    if (safeSpent >= thresholds.daySoftCents) {
      return { windowKind, tier: "soft", thresholdCents: thresholds.daySoftCents, spentCents: safeSpent };
    }
    return { windowKind, tier: "within", thresholdCents: null, spentCents: safeSpent };
  }
  if (safeSpent >= thresholds.monthHardCents) {
    return { windowKind, tier: "hard", thresholdCents: thresholds.monthHardCents, spentCents: safeSpent };
  }
  if (safeSpent >= thresholds.monthSoftCents) {
    return { windowKind, tier: "soft", thresholdCents: thresholds.monthSoftCents, spentCents: safeSpent };
  }
  return { windowKind, tier: "within", thresholdCents: null, spentCents: safeSpent };
}

export interface CombinedCapEvaluation {
  day: CapEvaluation;
  month: CapEvaluation;
  /**
   * `true` iff any hard cap is currently breached. The monitor uses this to
   * drive the atomic provider-enable flip.
   */
  shouldAutoDisable: boolean;
  /**
   * Aggregate cap-state label matching the B3 contract.
   */
  capState: "within-cap" | "soft-cap-breached" | "hard-cap-breached-auto-disabled";
}

export function evaluateCaps(input: {
  daySpentCents: number;
  monthSpentCents: number;
  thresholds: BillingCapThresholds;
}): CombinedCapEvaluation {
  const day = evaluateWindow("day", input.daySpentCents, input.thresholds);
  const month = evaluateWindow("month", input.monthSpentCents, input.thresholds);
  const shouldAutoDisable = day.tier === "hard" || month.tier === "hard";
  const capState = shouldAutoDisable
    ? "hard-cap-breached-auto-disabled"
    : day.tier === "soft" || month.tier === "soft"
      ? "soft-cap-breached"
      : "within-cap";
  return { day, month, shouldAutoDisable, capState };
}
