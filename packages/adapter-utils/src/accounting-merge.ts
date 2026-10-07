/** Merge usage/cost parsed from two views of the same run without downgrading.
 *
 * The display-stream checkpoint and the sanitized control records carry the
 * same run events, but redaction degrades each view differently: a display
 * counter matching a known secret value arrives as a literal `***REDACTED***`
 * marker, so that JSON record is unparseable and the checkpoint totals stay
 * low; the same counter in a control record is replaced with a type-preserving
 * `0`, so the control totals stay parseable but undercount that step. Neither
 * view can exceed the run's true totals, so the element-wise maximum keeps the
 * best available evidence instead of letting an emptier view overwrite a fuller
 * one. Cost follows the same rule: a null (missing/redacted) cost never
 * replaces a known cost. */
export interface AccountingCounters {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function mergeAccountingUsage<T extends AccountingCounters>(control: T, checkpoint: T): T {
  return {
    ...control,
    ...checkpoint,
    inputTokens: Math.max(control.inputTokens, checkpoint.inputTokens),
    outputTokens: Math.max(control.outputTokens, checkpoint.outputTokens),
    cachedInputTokens: Math.max(control.cachedInputTokens, checkpoint.cachedInputTokens),
  };
}

export interface CostEvidence {
  costUsd: number | null | undefined;
  /** False when the stream itself showed a cost was missing or unparseable. */
  costComplete: boolean;
}

/** Merge cost evidence without letting a partial sum pose as a priced total.
 *
 * The checkpoint sees the full stream, so its completeness verdict dominates:
 * a missing cost anywhere in the full stream makes the total unknown, even
 * when capped control capture still holds a partial sum from later steps.
 * Only when the checkpoint saw no cost evidence at all (e.g. its display
 * lines were redacted away while the sanitized control record stayed
 * parseable) does control's record fill the gap. */
export function mergeAccountingCost(control: CostEvidence, checkpoint: CostEvidence): number | null {
  if (!checkpoint.costComplete) return null;
  return checkpoint.costUsd ?? control.costUsd ?? null;
}
