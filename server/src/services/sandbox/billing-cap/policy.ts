/**
 * Phase 4A-S4 B2 (LET-367): pure cap-threshold policy.
 *
 * Mirrors S3 §3 thresholds for the E2B pilot. Pure module — no I/O, no clock
 * reads. Callers pass in current spend + window kind; the policy returns the
 * structured decision the monitor uses to drive notifier + persistence.
 */

/** All amounts are USD cents. */
export interface BillingCapThresholds {
  /** Daily soft cap (USD 15.00 default per S3 §3). */
  daySoftCents: number;
  /** Daily hard cap (USD 20.00 default per S3 §3). */
  dayHardCents: number;
  /** Monthly soft cap (USD 150.00 default per S3 §3). */
  monthSoftCents: number;
  /** Monthly hard cap (USD 200.00 default per S3 §3). */
  monthHardCents: number;
}

/** S3 §3 defaults for the E2B pilot. */
export const E2B_PILOT_THRESHOLDS: Readonly<BillingCapThresholds> = Object.freeze({
  daySoftCents: 15_00,
  dayHardCents: 20_00,
  monthSoftCents: 150_00,
  monthHardCents: 200_00,
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
