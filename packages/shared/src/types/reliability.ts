export const ISSUE_EXECUTION_HEALTH_STATES = [
  "live_run",
  "queued_wake",
  "awaiting_interaction",
  "awaiting_approval",
  "awaiting_user",
  "awaiting_review_participant",
  "blocked_waiting",
  "recovering",
  "watchdog_review",
  "degraded_runtime",
  "no_action_path",
  "invalid_state",
] as const;

export type IssueExecutionHealthState = (typeof ISSUE_EXECUTION_HEALTH_STATES)[number];

export const ISSUE_EXECUTION_HEALTH_REASON_CODES = [
  "active_execution_run",
  "queued_assignment_or_continuation",
  "pending_issue_thread_interaction",
  "pending_linked_approval",
  "human_assignee_owns_next_action",
  "execution_policy_participant_owns_next_action",
  "unresolved_blocker_chain_covered",
  "open_recovery_issue",
  "silent_active_run_under_watchdog",
  "agent_uninvokable",
  "blocked_by_unassigned_issue",
  "blocked_by_cancelled_issue",
  "in_review_without_action_path",
  "assigned_todo_without_dispatch_path",
  "assigned_in_progress_without_execution_path",
  "issue_terminal",
] as const;

export type IssueExecutionHealthReasonCode = (typeof ISSUE_EXECUTION_HEALTH_REASON_CODES)[number];

export interface IssueExecutionHealthRunEvidence {
  runId: string;
  status: string;
  livenessState: string | null;
  livenessReason: string | null;
  silenceLevel: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed" | null;
}

export interface IssueExecutionHealthQueuedWakeEvidence {
  wakeupRequestId: string;
  reason: string | null;
  status: string;
}

export interface IssueExecutionHealthInteractionEvidence {
  interactionId: string;
  kind: string;
  status: string;
}

export interface IssueExecutionHealthApprovalEvidence {
  approvalId: string;
  status: string;
}

export interface IssueExecutionHealthRecoveryEvidence {
  recoveryIssueId: string;
  recoveryIssueIdentifier: string | null;
  originKind: string;
}

export interface IssueExecutionHealthBlockerEvidence {
  blockerIssueId: string;
  blockerIssueIdentifier: string | null;
  blockerStatus: string;
}

export interface IssueExecutionHealthEvidence {
  activeRun?: IssueExecutionHealthRunEvidence | null;
  queuedWake?: IssueExecutionHealthQueuedWakeEvidence | null;
  pendingInteraction?: IssueExecutionHealthInteractionEvidence | null;
  pendingApproval?: IssueExecutionHealthApprovalEvidence | null;
  recoveryIssue?: IssueExecutionHealthRecoveryEvidence | null;
  blocker?: IssueExecutionHealthBlockerEvidence | null;
  reviewParticipantStatus?: string | null;
}

export interface IssueExecutionHealthSummary {
  state: IssueExecutionHealthState;
  reasonCode: IssueExecutionHealthReasonCode;
  reason: string;
  nextActionOwner: "assignee_agent" | "assignee_user" | "review_participant" | "blocker_owner" | "recovery_owner" | "system" | "none";
  evidence: IssueExecutionHealthEvidence;
  evaluatedAt: string;
}
