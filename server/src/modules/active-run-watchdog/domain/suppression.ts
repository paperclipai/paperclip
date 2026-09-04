export type SuppressionSignals = {
  snoozedOrContinued?: boolean;
  recoveryOriginSource?: boolean;
  blockedSource?: boolean;
  dismissedFalsePositive?: boolean;
};

export type SuppressionReason =
  | "snoozed"
  | "recovery_origin_source"
  | "blocked_source"
  | "dismissed_false_positive";

export type SuppressionResult =
  | { suppressed: false }
  | { suppressed: true; reason: SuppressionReason };

/**
 * Decides whether a signal on a silent active run suppresses recovery work.
 * The caller passes only the signals it has resolved at its call site; an
 * unresolved signal must be left `undefined`, not `false`, so this function
 * checks each rule in a fixed priority order and returns the first match.
 */
export function evaluateSuppression(signals: SuppressionSignals): SuppressionResult {
  if (signals.snoozedOrContinued) return { suppressed: true, reason: "snoozed" };
  if (signals.recoveryOriginSource) return { suppressed: true, reason: "recovery_origin_source" };
  if (signals.blockedSource) return { suppressed: true, reason: "blocked_source" };
  if (signals.dismissedFalsePositive) return { suppressed: true, reason: "dismissed_false_positive" };
  return { suppressed: false };
}
