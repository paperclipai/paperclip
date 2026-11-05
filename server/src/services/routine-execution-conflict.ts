import { isUniqueViolation } from "../db-errors.js";
import { conflict, HttpError } from "../errors.js";

export const OPEN_ROUTINE_EXECUTION_CONSTRAINT = "issues_open_routine_execution_uq";

export function isOpenRoutineExecutionViolation(error: unknown): boolean {
  return isUniqueViolation(error, OPEN_ROUTINE_EXECUTION_CONSTRAINT);
}

export function routineExecutionConflict(details: Record<string, unknown>): HttpError {
  return conflict("Issue checkout conflict", {
    ...details,
    code: "routine_execution_conflict",
    constraint: OPEN_ROUTINE_EXECUTION_CONSTRAINT,
  });
}

export function isRoutineExecutionConflict(error: unknown): error is HttpError {
  if (!(error instanceof HttpError) || error.status !== 409) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { code?: unknown }).code === "routine_execution_conflict"
  );
}
