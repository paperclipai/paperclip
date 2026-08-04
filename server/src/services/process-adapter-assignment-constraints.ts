// RENA-1628: prevent process adapters from auto-claiming a queued run for an issue that is
// currently execution-locked by a different run and is waiting on a human (a pending thread
// interaction or a pending/revision-requested approval). Without this gate, a process adapter
// (the default local adapter that shells out to an agent-configured command) can pile onto an
// issue mid human-in-the-loop review instead of leaving it for the human to unblock.

export const PROCESS_ADAPTER_HUMAN_ACTION_LOCK_BLOCKED_REASON =
  "process_adapter_human_action_lock_blocked";

export const DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES = ["process"] as const;

const RESTRICTED_ADAPTER_TYPES_ENV_KEY = "PROCESS_ADAPTER_AUTO_ASSIGNMENT_RESTRICTED_TYPES";

/**
 * Adapter types subject to the locked+human-action auto-assignment constraint. Defaults to just
 * "process", but is overridable via PROCESS_ADAPTER_AUTO_ASSIGNMENT_RESTRICTED_TYPES (a
 * comma-separated list) so the restriction can be widened/narrowed without a deploy.
 */
export function resolveHumanActionLockRestrictedAdapterTypes(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const configured = env[RESTRICTED_ADAPTER_TYPES_ENV_KEY];
  if (!configured) return new Set(DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES);
  const types = configured
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type.length > 0);
  return types.length > 0 ? new Set(types) : new Set(DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES);
}

export type ProcessAdapterAutoAssignmentConstraintInput = {
  adapterType: string;
  /** The run attempting to claim the queued work. */
  currentRunId: string;
  /** The issue's current execution lock timestamp, if any. */
  executionLockedAt: Date | string | null;
  /** The run id that currently owns the issue's execution lock, if any. */
  executionLockRunId: string | null;
  /** Whether the issue has a pending thread interaction or a pending/revision-requested approval. */
  hasPendingHumanAction: boolean;
  restrictedAdapterTypes?: Set<string>;
};

export type ProcessAdapterAutoAssignmentConstraintResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: typeof PROCESS_ADAPTER_HUMAN_ACTION_LOCK_BLOCKED_REASON;
      adapterType: string;
    };

/**
 * Pure decision function: given the facts about a queued run's target issue, decide whether a
 * process (or otherwise restricted) adapter may claim it. Kept free of DB access so it can be
 * unit tested directly; callers are responsible for fetching executionLockedAt/executionRunId
 * and pending-interaction/approval state before calling this.
 */
export function checkProcessAdapterAutoAssignmentConstraint(
  input: ProcessAdapterAutoAssignmentConstraintInput,
): ProcessAdapterAutoAssignmentConstraintResult {
  const restrictedAdapterTypes =
    input.restrictedAdapterTypes ?? resolveHumanActionLockRestrictedAdapterTypes();
  if (!restrictedAdapterTypes.has(input.adapterType)) return { allowed: true };
  if (!input.executionLockedAt) return { allowed: true };
  // A run reclaiming the lock it already holds (retry/resume) isn't a foreign lock — allow it.
  if (input.executionLockRunId && input.executionLockRunId === input.currentRunId) {
    return { allowed: true };
  }
  if (!input.hasPendingHumanAction) return { allowed: true };

  return {
    allowed: false,
    reason: PROCESS_ADAPTER_HUMAN_ACTION_LOCK_BLOCKED_REASON,
    adapterType: input.adapterType,
  };
}
