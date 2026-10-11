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
  /** Cost-bearing records this view parsed, priced or not. */
  costRecords: number;
}

/** Merge cost evidence without letting a partial sum pose as a priced total.
 *
 * The checkpoint sees the full stream, so its completeness verdict dominates:
 * a missing cost anywhere in the full stream makes the total unknown, even
 * when capped control capture still holds a partial sum from later steps.
 *
 * The checkpoint reads the redacted display stream, where a record whose
 * counter matched a secret no longer parses. `checkpointUnreadRecords` counts
 * those, so the checkpoint sum excludes them and is only a lower bound. The
 * sanitized control view keeps such a record parseable, but its capture is
 * capped, so it supplies the total only when it parsed every cost-bearing
 * record the full stream carried. Otherwise the total is unknown. */
export function mergeAccountingCost(
  control: CostEvidence,
  checkpoint: CostEvidence,
  checkpointUnreadRecords = 0,
): number | null {
  if (!checkpoint.costComplete) return null;
  if (checkpointUnreadRecords === 0) return checkpoint.costUsd ?? control.costUsd ?? null;
  const expectedRecords = checkpoint.costRecords + checkpointUnreadRecords;
  return control.costComplete && control.costRecords >= expectedRecords ? control.costUsd ?? null : null;
}
