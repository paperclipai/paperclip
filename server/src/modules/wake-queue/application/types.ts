import type { ReleaseRecoveryBlockedNoticeKind } from "../domain/policy.js";

export type RunSummary = {
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  wakeupRequestId: string | null;
};

export type RunSnapshot = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  runtimeMode: string | null;
  errorCode: string | null;
  responsibleUserId: string | null;
  /** The run's own context snapshot, kept as plain JSON so ports carry no drizzle types. */
  contextSnapshot: Record<string, unknown>;
  /** `resultJson.configurationIncomplete`, already parsed; non-null only on a configuration-incomplete failed run. */
  configurationIncompletePayload: Record<string, unknown> | null;
  /** The host schedules failed conversation turns with its durable retry budget. */
  conversationContinuation?: boolean;
};

export type IssueSnapshot = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
  id: string;
  companyId: string;
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  hiddenAt: Date | null;
  originKind: string | null;
  monitorNextCheckAt: Date | null;
  executionState: Record<string, unknown> | null;
  /** Carried so the routine-env and responsible-user reader ports can use this
   * transaction-scoped snapshot instead of reading the issue again. */
  responsibleUserId: string | null;
  parentId: string | null;
  originId: string | null;
  originRunId: string | null;
};

export type InvokableAgentSnapshot = {
  id: string;
  companyId: string;
  name: string | null;
  invokable: boolean;
};

/** A new heartbeat run reached the queued state and should be published and dispatched. */
export type RunQueuedEffect = {
  kind: "run_queued";
  run: RunSummary;
};

/** An issue reopened from done/cancelled because a live deferred comment wake promoted on it. */
export type IssueReopenedEffect = {
  kind: "issue_reopened";
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  identifier: string;
  reopenedFrom: string;
};

/** Explicit post-commit work a caller applies only after the release transaction commits. */
export type PostCommitEffect = RunQueuedEffect | IssueReopenedEffect | {
  kind: "conversation_retry_requested";
  companyId: string;
  runId: string;
  reviewParticipant: boolean;
};

export type ReleaseOutcome =
  | { kind: "released" }
  | { kind: "promoted"; run: RunSummary }
  | { kind: "queued_review_participant_recovery"; run: RunSummary }
  | { kind: "queued_recovery"; run: RunSummary }
  | {
      kind: "blocked";
      issue: IssueSnapshot;
      previousStatus: "todo" | "in_progress" | "in_review";
      noticeKind: ReleaseRecoveryBlockedNoticeKind;
    }
  | {
      kind: "blocked_recovery_in_place";
      issue: IssueSnapshot;
      previousStatus: "todo" | "in_progress" | "in_review";
    };

export type WakeQueueApplicationErrorCode = "responsible_user_unresolved" | "deferred_wake_not_advanced";

export class WakeQueueApplicationError extends Error {
  constructor(
    readonly code: WakeQueueApplicationErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WakeQueueApplicationError";
  }
}
