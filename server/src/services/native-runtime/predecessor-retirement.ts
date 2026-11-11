/**
 * A new run on a reused sandbox must first retire the previous run's warm
 * Runner there. When that retirement stays unproven (its close failed, or its
 * durable journal cannot prove the owner finished), the new run has done no
 * provider work. It must not fail the task: the next attempt drops the reused
 * sandbox and starts on a fresh one restored from the saved workspace, which
 * cannot meet the old Runner. The old sandbox is kept for the cleanup sweep.
 */
export const NATIVE_PREDECESSOR_RETIREMENT_UNPROVEN_CODE = "native_predecessor_retirement_unproven";

/** Lease metadata key: the next acquisition replaces this sandbox instead of resuming it. */
export const REPLACE_BEFORE_REUSE_KEY = "replaceBeforeReuse";
export const REPLACE_BEFORE_REUSE_SCHEMA = "paperclip.replace-before-reuse.v1";

export class NativePredecessorRetirementUnprovenError extends Error {
  readonly code = NATIVE_PREDECESSOR_RETIREMENT_UNPROVEN_CODE;
  constructor(
    readonly predecessorRunId: string | null,
    /** The sandbox that still holds the unretired owner, when known. */
    readonly providerLeaseId: string | null,
    cause: unknown,
  ) {
    super(`The previous run's session on this sandbox could not be retired (${
      cause instanceof Error ? cause.message : String(cause)}). The next attempt starts on a fresh sandbox.`, { cause });
    this.name = "NativePredecessorRetirementUnprovenError";
  }
}

/** The typed error itself or one of its first causes (AggregateError members included). */
export function findNativePredecessorRetirementUnproven(error: unknown): NativePredecessorRetirementUnprovenError | null {
  const pending: unknown[] = [error];
  for (let seen = 0; pending.length > 0 && seen < 16; seen++) {
    const current = pending.shift();
    if (current instanceof NativePredecessorRetirementUnprovenError) return current;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return null;
}

/** Durable record on a failed run whose next attempt drops its reused sandbox. */
export const PREDECESSOR_RETIREMENT_FALLBACK_KEY = "predecessorRetirementFallback";

export type PredecessorRetirementFallback = {
  version: 1;
  providerWorkStarted: false;
  predecessorRunId: string | null;
  replacedProviderLeaseIds: string[];
};

export function readPredecessorRetirementFallback(resultJson: unknown): PredecessorRetirementFallback | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const value = (resultJson as Record<string, unknown>)[PREDECESSOR_RETIREMENT_FALLBACK_KEY];
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.providerWorkStarted === false ? record as PredecessorRetirementFallback : null;
}

export type ReplaceBeforeReuseMarker = {
  schema: typeof REPLACE_BEFORE_REUSE_SCHEMA;
  runId: string;
  predecessorRunId: string | null;
  recordedAt: string;
};

export function readReplaceBeforeReuseMarker(metadata: Record<string, unknown> | null | undefined): ReplaceBeforeReuseMarker | null {
  const value = metadata?.[REPLACE_BEFORE_REUSE_KEY];
  if (typeof value !== "object" || value === null) return null;
  const marker = value as Record<string, unknown>;
  return marker.schema === REPLACE_BEFORE_REUSE_SCHEMA && typeof marker.runId === "string"
    ? marker as ReplaceBeforeReuseMarker : null;
}
