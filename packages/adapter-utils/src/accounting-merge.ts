/** Keep lower-bound usage evidence from two views of the same run.
 *
 * A secret-valued counter makes its display record unreadable and becomes zero
 * in sanitized control output. Control capture can also omit early records.
 * The element-wise maximum avoids replacing fuller evidence with smaller totals,
 * but it cannot reconstruct the union when the views omit different records.
 * Callers must mark usage incomplete after any unread full-stream accounting
 * record, even when control recovers a complete price. Cost has a separate
 * coverage-aware merge below; usage counters must never be reconstructed from
 * secret values or presented as complete merely because a price is known. */
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
