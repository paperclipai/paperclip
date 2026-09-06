import type {
  QueuedRunStalenessErrorCode,
  ScheduledRetryGateErrorCode,
} from "../domain/policy.js";

/**
 * An opaque view of a `heartbeat_runs` row. The application layer never reads
 * or writes a field on this type; it only carries the row from a writer,
 * through a use case, back to the caller, so the caller can publish the same
 * post-commit events it publishes today. Only the adapter and the caller
 * agree on the real shape.
 */
export type HeartbeatRunRecord = Record<string, unknown>;

/**
 * A description of one publish or telemetry step a caller must run after an
 * operation's transaction commits. An operation returns this list instead of
 * publishing itself, so a lost connection during publish never rolls back a
 * write that already committed. The caller applies every effect on a
 * best-effort basis, exactly as it does today.
 */
export type PostCommitEffect =
  | { kind: "run_queued"; run: HeartbeatRunRecord }
  | {
      kind: "run_status_published";
      run: HeartbeatRunRecord;
      previousStatus: string | null;
    };

export type PromoteScheduledRetryOutcome =
  | { outcome: "promoted"; run: HeartbeatRunRecord; postCommitEffects: PostCommitEffect[] }
  | {
      outcome: "gate_suppressed";
      run: HeartbeatRunRecord;
      reason: string;
      errorCode: ScheduledRetryGateErrorCode;
    }
  | { outcome: "not_promoted"; run: null };

export type CancelStaleQueuedRunOutcome =
  | { outcome: "not_stale" }
  | {
      outcome: "cancelled";
      run: HeartbeatRunRecord;
      reason: string;
      errorCode: QueuedRunStalenessErrorCode;
      postCommitEffects: PostCommitEffect[];
    };

export type RunDispatchApplicationErrorCode = "run_not_found";

/**
 * Signals a boundary defect: a caller named a run id, an issue id, or a
 * company id that the reader could not find. Every caller of this module
 * already holds the run it names, so this error should never fire in normal
 * operation; it exists so a data race fails loudly instead of silently.
 */
export class RunDispatchApplicationError extends Error {
  constructor(
    readonly code: RunDispatchApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunDispatchApplicationError";
  }
}
