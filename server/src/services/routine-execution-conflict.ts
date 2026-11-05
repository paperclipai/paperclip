import { isUniqueViolation } from "../db-errors.js";
import { conflict, HttpError } from "../errors.js";

/**
 * Partial unique index that keeps a single open execution task per routine.
 *
 * `issues_open_routine_execution_uq` covers
 * (company_id, origin_kind, origin_id, origin_fingerprint) for rows whose
 * origin_kind is `routine_execution`, whose origin_id is set, that are not
 * hidden, that already hold an execution_run_id, and whose status is still
 * open. The database therefore rejects a second open example of the same
 * routine with SQLSTATE 23505 as soon as a write binds a run to it.
 *
 * That rejection is a legitimate conflict ("another execution for this routine
 * is already in progress"), not a server fault. Every write that can take the
 * execution slot has to translate the driver error into the structured
 * conflict below so the API answers 409 instead of 500.
 */
export const OPEN_ROUTINE_EXECUTION_CONSTRAINT = "issues_open_routine_execution_uq";

/** True when the driver rejected the write because another open example of the same routine holds the execution slot. */
export function isOpenRoutineExecutionViolation(error: unknown): boolean {
  return isUniqueViolation(error, OPEN_ROUTINE_EXECUTION_CONSTRAINT);
}

/**
 * The structured conflict for this invariant.
 *
 * The message matches the conflict `checkout` already raises for a live
 * checkout owner, so callers that recognise that shape (for example the
 * heartbeat auto-checkout) treat this the same way instead of crashing on the
 * raw driver error.
 */
export function routineExecutionConflict(details: Record<string, unknown>): HttpError {
  return conflict("Issue checkout conflict", {
    ...details,
    code: "routine_execution_conflict",
    constraint: OPEN_ROUTINE_EXECUTION_CONSTRAINT,
  });
}

/** True for the structured conflict produced by {@link routineExecutionConflict}. */
export function isRoutineExecutionConflict(error: unknown): error is HttpError {
  if (!(error instanceof HttpError) || error.status !== 409) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { code?: unknown }).code === "routine_execution_conflict"
  );
}
