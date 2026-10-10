export type RunStatus = string;

export type RunSnapshot = {
  id: string;
  companyId: string;
  agentId: string;
  status: RunStatus;
  lastOutputAt: Date | null;
  lastOutputSeq: number | null;
  lastOutputStream: string | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
  sourceIssueId: string | null;
  resultJson: unknown;
  wakeupRequestId: string | null;
  processPid: number | null;
  processGroupId: number | null;
};

export type SourceIssueSnapshot = {
  id: string;
  identifier: string | null;
  status: string;
  originKind: string | null;
  isRecoveryOriginKind: boolean;
};

export type EvaluationIssueSnapshot = {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  companyId: string;
  originKind: string;
  originId: string | null;
  hiddenAt: Date | null;
};

export type TerminalEvidence = {
  kind: "activity";
  id: string;
  createdAt: Date;
  action: string;
};

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

export type ScanSilentActiveRunsResult = {
  scanned: number;
  created: number;
  existing: number;
  escalated: number;
  folded: number;
  snoozed: number;
  skipped: number;
  evaluationIssueIds: string[];
};

export type RunProcessMetadata = {
  runId: string;
  adapterType: string;
  fallbackPid: number | null;
  fallbackProcessGroupId: number | null;
};

export type RunProcessCleanupOutcome =
  | {
      attempted: false;
      outcome: "skipped_non_local_adapter" | "no_process_metadata" | "not_running";
      adapterType: string;
      pid?: number | null;
      processGroupId?: number | null;
    }
  | {
      attempted: true;
      outcome: "terminated" | "termination_sent_still_running";
      adapterType: string;
      pid: number | null;
      processGroupId: number | null;
    }
  | {
      attempted: true;
      outcome: "failed";
      adapterType: string;
      pid: number | null;
      processGroupId: number | null;
      error: string;
    };

export type FoldSourceResolvedRunInput = {
  run: RunSnapshot;
  sourceIssue: SourceIssueSnapshot;
  evidence: TerminalEvidence;
  existingEvaluation: EvaluationIssueSnapshot | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  cleanup: RunProcessCleanupOutcome;
  now: Date;
};

export type FoldOutcome =
  | { kind: "folded"; evaluationIssueId: string | null }
  | { kind: "stale" };

export type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RecordDecisionInput = {
  runId: string;
  actor: WatchdogDecisionActor;
  evaluationIssueId: string | null;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  snoozedUntil: Date | null;
  reason: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
};

export type WatchdogDecisionRecord = {
  id: string;
  companyId: string;
  runId: string;
  evaluationIssueId: string | null;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  snoozedUntil: Date | null;
  reason: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
};

export type WatchdogDecisionApplicationErrorCode =
  | "run_not_found"
  | "evaluation_issue_not_found"
  | "not_authorized"
  | "evaluation_issue_mismatch"
  | "evaluation_issue_required"
  | "creator_run_invalid";

export class WatchdogDecisionApplicationError extends Error {
  constructor(
    readonly code: WatchdogDecisionApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WatchdogDecisionApplicationError";
  }
}
