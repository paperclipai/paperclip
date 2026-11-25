// Leaf module: the unchanged-baseline receipt that remote workspace writers
// record. Recovery proofs read it without loading the unchanged-proof module.

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * A writer's prepared files equal its saved version only while nothing ran in
 * them. Preparation records that starting point; everything after it leaves a
 * durable record (an operation, a runner checkpoint, a run event or a
 * process) before it can write. A run with none of those changed nothing.
 */
export const UNCHANGED_BASELINE_KEY = "remoteWorkspaceUnchangedBaseline";
export const UNCHANGED_BASELINE_SCHEMA = "paperclip.remote-workspace-unchanged-baseline.v1";

export type UnchangedBaseline = {
  schema: typeof UNCHANGED_BASELINE_SCHEMA; epoch: number; runId: string; snapshotId: string;
  /** Set once the writer was released without a new save. */
  releasedAt?: string;
};

/** Missing or malformed fields (an older or partial record) never prove anything. */
export function readUnchangedBaseline(metadata: Record<string, unknown> | null | undefined): UnchangedBaseline | null {
  const value = object(metadata?.[UNCHANGED_BASELINE_KEY]);
  if (value.schema !== UNCHANGED_BASELINE_SCHEMA || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
    || typeof value.runId !== "string" || !value.runId || typeof value.snapshotId !== "string" || !value.snapshotId
    || (value.releasedAt !== undefined && typeof value.releasedAt !== "string")) return null;
  return value as UnchangedBaseline;
}
