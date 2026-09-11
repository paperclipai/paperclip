export interface ExecutionBlocker {
  recoveryActionId: string;
  runId: string | null;
  agentId: string | null;
  cause: string;
  nextAction: string;
}

/** Presentation of existing execution records, not a second task status machine. */
export interface ExecutionProjection {
  phase:
    | "working"
    | "reconnecting"
    | "retry_scheduled"
    | "finishing"
    | "recovery_needed"
    | "waiting_for_access"
    | "waiting_for_answer"
    | "queued"
    | "completed"
    | "failed";
  label: string;
  cause: string | null;
  lastConfirmedActivityAt: string | null;
  retryAt: string | null;
  attempt: number;
  maxAttempts: number;
  recoveryOwner: "agent" | "board" | null;
  nextAction: string | null;
  permittedActions: Array<"inspect_run" | "inspect_recovery">;
  predecessorRunId: string | null;
  successorRunId: string | null;
}

/** These incidents require an explicit reconciliation, never a generic Retry. */
export const EXECUTION_RECONCILIATION_CAUSES = [
  "uncertain_provider_action",
  "uncertain_external_action",
  "uncertain_control_plane_action",
  "completed_action_context_missing",
  "continuation_evidence_incomplete",
  "execution_finalization_deadline_exceeded",
  "execution_recovery_budget_exhausted",
  "provider_effect_inventory_unavailable",
  "provider_failure_meaning_unverified",
  "provider_ownership_unverified",
  "native_provider_terminal_failed",
  "native_event_replay_conflict",
  "native_session_cleanup_quarantined",
  "native_session_retry_exhausted",
  "native_restart_recovery_blocked",
  "native_continuation_requires_reconciliation",
  "legacy_execution_requires_reconciliation",
] as const;
export function requiresExecutionReconciliation(
  cause: string | null | undefined,
): boolean {
  return EXECUTION_RECONCILIATION_CAUSES.some((value) => value === cause);
}

export interface ExecutionReconciliation {
  runId: string;
  providerStopped: true;
  actionOutcome: "completed" | "not_performed" | "mixed";
  outcomeEvidence: string;
}
