/**
 * A native run can finish its provider turn and then be refused by the
 * runner's cleanup gate: the previous session's shutdown is still unproven
 * (`native_session_cleanup_quarantined`). The work of that turn is already
 * saved. Cleanup settles on its own once the environment proves the old
 * runner, provider and tools stopped (lease release and termination receipts,
 * see `acknowledgeRemoteStop` in heartbeat/run-control.ts). It is not a failed
 * attempt and it never needs an administrator.
 *
 * Every rule here reads only fields earlier releases already persisted
 * (`errorCode` and `runnerProfileJson.sessionCheckpoint`), so runs quarantined
 * before this change are classified the same way without a migration.
 */

export const NATIVE_SESSION_CLEANUP_QUARANTINED = "native_session_cleanup_quarantined";

/** Plain wording for the cleanup gate. It names no person who must act. */
export const NATIVE_CLEANUP_SETTLING_MESSAGE =
  "The previous session is still shutting down. Your work is saved, and Paperclip finishes the cleanup automatically.";

/** Shown for a quarantined run whose provider turn had already completed. */
export const NATIVE_COMPLETED_TURN_CLEANUP_MESSAGE =
  "This run finished its work and saved it. Paperclip finishes the session cleanup automatically. Send a message to continue; it starts once the previous session has stopped.";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The run's own saved checkpoint records a completed provider turn and no
 * turn still active. Only the checkpoint saved for this exact run counts. */
export function nativeCheckpointRecordsCompletedTurn(runnerProfileJson: unknown, runId: string): boolean {
  const checkpoint = record(record(runnerProfileJson).sessionCheckpoint);
  const terminal = record(checkpoint.terminal);
  return record(checkpoint.identity).runId === runId
    && (checkpoint.activeTurnId === null || checkpoint.activeTurnId === undefined)
    && terminal.turnTerminalState === "completed";
}

/** A failed native run whose only failure is unproven cleanup after its
 * provider turn completed. Its work is done; it is not an attempt to retry. */
export function isCompletedTurnCleanupQuarantine(run: {
  id: string;
  runtimeMode?: string | null;
  status?: string | null;
  errorCode?: string | null;
  runnerProfileJson?: unknown;
}): boolean {
  return run.runtimeMode === "native" && run.status === "failed"
    && run.errorCode === NATIVE_SESSION_CLEANUP_QUARANTINED
    && nativeCheckpointRecordsCompletedTurn(run.runnerProfileJson, run.id);
}
