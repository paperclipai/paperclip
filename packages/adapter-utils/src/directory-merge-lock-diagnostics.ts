import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE, type DirectoryMergeLockOperation } from "./workspace-restore-merge.js";

const OPERATIONS = [
  "agent_directory_prepare",
  "agent_directory_release",
  "agent_directory_collect",
  "agent_directory_checkpoint",
  "agent_directory_handoff",
] as const satisfies readonly DirectoryMergeLockOperation[];
// Fails to compile when the lock module adds an operation this list omits.
const OPERATIONS_COMPLETE: [Exclude<DirectoryMergeLockOperation, typeof OPERATIONS[number]>] extends [never] ? true : false = true;
void OPERATIONS_COMPLETE;
const OWNER_STATES = ["alive", "dead", "unknown", "missing", "invalid"] as const;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Holder evidence a directory-merge lock timeout carries, reduced to closed
 * labels, booleans and bounded durations. It never includes the lock path,
 * the owner's process id, or any error message.
 */
export interface DirectoryMergeLockTimeoutDiagnostics {
  operation?: DirectoryMergeLockOperation;
  ownerState?: typeof OWNER_STATES[number];
  knownLocalHolder?: boolean;
  ownerSameProcess?: boolean;
  ownerPredatesProcess?: boolean;
  ownerAgeMs?: number;
  waitMs?: number;
}

function read(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Returns the allowlisted holder diagnostics when `error` itself is a
 * directory-merge lock timeout, otherwise `null`. Invalid or unknown values
 * are omitted rather than copied.
 */
export function directoryMergeLockTimeoutDiagnosticsFor(error: unknown): DirectoryMergeLockTimeoutDiagnostics | null {
  if (read(error, "code") !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) return null;
  const lock = read(error, "workspaceRestoreLock");
  const diagnostics: DirectoryMergeLockTimeoutDiagnostics = {};
  const operation = read(lock, "operation");
  const operationLabel = OPERATIONS.find((value) => value === operation);
  if (operationLabel) diagnostics.operation = operationLabel;
  const ownerState = read(lock, "ownerState");
  const ownerStateLabel = OWNER_STATES.find((value) => value === ownerState);
  if (ownerStateLabel) diagnostics.ownerState = ownerStateLabel;
  for (const field of ["knownLocalHolder", "ownerSameProcess", "ownerPredatesProcess"] as const) {
    const value = read(lock, field);
    if (typeof value === "boolean") diagnostics[field] = value;
  }
  for (const field of ["ownerAgeMs", "waitMs"] as const) {
    const value = read(lock, field);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS) diagnostics[field] = value;
  }
  return diagnostics;
}
