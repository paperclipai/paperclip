// Runtime post-condition guard for routine-fire heartbeats.
//
// Detects the class of failure where a scheduled routine fire ends
// "succeeded" from the adapter's point of view but the agent never PATCHed
// the execution issue to a terminal state, never posted a comment, and never
// created a child issue. Without this guard the issue sits at `in_progress`
// until some external productivity scanner picks it up hours later; when this
// happens across a whole routine — e.g. a scheduled QA reviewer that
// mis-uses a wake-request API and silently no-ops — it can spawn dozens or
// hundreds of stranded-recovery children before anyone notices.
//
// The evaluation is expressed as a pure predicate so unit tests can cover
// every branch without a DB. The runtime wrapper in heartbeat.ts collects
// the inputs (issue row, `findRunIssueComment`, run-window child-issue
// probe) and applies the effects.

export const HEARTBEAT_POSTCONDITION_EVENT_TYPE =
  "heartbeat.postcondition.no_terminal_patch";

export const HEARTBEAT_POSTCONDITION_TERMINAL_STATUS = "done" as const;

export const HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY =
  "Auto-terminated by the runtime — routine fire ended without a terminal " +
  "PATCH: no status update, no comment, and no child issue during this run. " +
  "The next scheduled fire of this routine will re-pick up whatever state " +
  "exists.";

export type HeartbeatPostConditionReason =
  | "not_routine_execution"
  | "run_not_guarded_outcome"
  | "issue_already_terminal"
  | "run_recorded_progress"
  | "no_terminal_patch";

export interface HeartbeatPostConditionInput {
  // originKind of the checked-out issue. Only `routine_execution` is guarded.
  issueOriginKind: string | null | undefined;
  // Status of the checked-out issue AFTER the adapter exited.
  issueStatus: string | null | undefined;
  // Terminal outcome the runtime is about to persist for the run.
  runOutcome: string | null | undefined;
  // True when at least one issue_comment row exists with createdByRunId = run.id.
  hasRunComment: boolean;
  // True when at least one issue was created by this run's agent during the
  // run window (parented to the execution issue or otherwise).
  hasRunChildIssue: boolean;
}

export interface HeartbeatPostConditionDecision {
  triggered: boolean;
  reason: HeartbeatPostConditionReason;
}

// Only fire when the adapter reported success. `failed` / `timed_out` already
// have retry / recovery paths, and `cancelled` is an intentional abort.
const GUARDED_RUN_OUTCOMES = new Set<string>(["succeeded"]);

export function evaluateHeartbeatPostCondition(
  input: HeartbeatPostConditionInput,
): HeartbeatPostConditionDecision {
  if (input.issueOriginKind !== "routine_execution") {
    return { triggered: false, reason: "not_routine_execution" };
  }
  if (!GUARDED_RUN_OUTCOMES.has(input.runOutcome ?? "")) {
    return { triggered: false, reason: "run_not_guarded_outcome" };
  }
  // Any status other than `in_progress` means the agent (or another actor)
  // already moved the issue: done, blocked, cancelled, in_review, handoff back
  // to todo/backlog. Nothing to enforce.
  if (input.issueStatus !== "in_progress") {
    return { triggered: false, reason: "issue_already_terminal" };
  }
  if (input.hasRunComment || input.hasRunChildIssue) {
    return { triggered: false, reason: "run_recorded_progress" };
  }
  return { triggered: true, reason: "no_terminal_patch" };
}
