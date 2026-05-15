// Tier-0 structural pre-filter for the Clarifier plugin.
//
// Pure functions only. No I/O. Decides whether an issue is *eligible* for
// clarification based on the structured signals listed in CAL-112. The next
// tier (CAL-113) does the LLM call and only sees issues that pass here.

export type EligibleStatus = "in_progress" | "in_review" | "blocked";
export const ELIGIBLE_STATUSES: readonly EligibleStatus[] = [
  "in_progress",
  "in_review",
  "blocked",
] as const;

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export const QUESTION_KEYWORD_RE =
  /\b(should|could|can|which|what|how|who|when|approve|confirm)\b.*\?/i;

export type TriggerKind =
  | "comment.created"
  | "issue.status_changed"
  | "agent.run.finished"
  | "scheduled.evaluate";

export type ActorType = "agent" | "user" | "system" | "plugin";

export interface FixtureIssue {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  updatedAt: Date;
}

export interface FixtureComment {
  id: string;
  body: string;
  actorType: ActorType;
  authorAgentId: string | null;
  createdAt: Date;
}

export interface FixtureBlocker {
  id: string;
  status: string;
  /**
   * Whether this blocker is itself stuck (e.g. blocked, or in_progress with
   * no run finished in some configurable window). The worker computes this
   * one level deep — Tier-0 just consumes the boolean.
   */
  stuck: boolean;
}

export type Trigger =
  | {
      kind: "comment.created";
      comment: FixtureComment;
    }
  | {
      kind: "issue.status_changed";
      previousStatus: string | null;
      newStatus: string;
    }
  | {
      kind: "agent.run.finished";
      runId: string;
      runFinishedAt: Date;
    }
  | {
      kind: "scheduled.evaluate";
    };

export interface Tier0Input {
  issue: FixtureIssue;
  trigger: Trigger;
  /** Most recent comment on the issue (any author), if any. */
  latestComment?: FixtureComment | null;
  /**
   * Wall-clock time of the most recent finished run for this issue's assignee,
   * scoped to this issue if known. Used for the "run finished in last hour
   * and nothing changed" signal.
   */
  lastRunFinishedAt?: Date | null;
  /**
   * Wall-clock time the issue's `status` or `assigneeAgentId` last changed.
   * Used to detect "nothing changed since the run finished".
   */
  statusOrAssigneeChangedAt?: Date | null;
  /** Direct blockers; the worker pre-computes the `stuck` flag at depth 1. */
  blockers?: FixtureBlocker[];
  /** Evaluation clock. Defaults to `new Date()`. */
  now?: Date;
}

export type EligibilitySignal =
  | "agent_question"
  | "transitioned_to_blocked"
  | "run_finished_no_change"
  | "stale_after_agent_comment"
  | "stuck_blocker";

export type IneligibilityReason =
  | "status_not_eligible"
  | "missing_assignee"
  | "no_signal";

export interface Tier0Verdict {
  eligible: boolean;
  signals: EligibilitySignal[];
  reasons: IneligibilityReason[];
}

function isEligibleStatus(status: string): status is EligibleStatus {
  return (ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

function commentLooksLikeQuestion(body: string): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  if (trimmed.endsWith("?")) return true;
  return QUESTION_KEYWORD_RE.test(trimmed);
}

function commentIsFromAgent(comment: FixtureComment): boolean {
  return comment.actorType === "agent" && comment.authorAgentId != null;
}

/**
 * Pure structural pre-filter. Returns a verdict plus the list of signals that
 * fired (for traceability) and the list of reasons the issue is ineligible (if
 * any). Always safe to call — no I/O, no side effects.
 */
export function evaluateTier0(input: Tier0Input): Tier0Verdict {
  const now = input.now ?? new Date();
  const { issue, trigger } = input;

  const reasons: IneligibilityReason[] = [];
  if (!isEligibleStatus(issue.status)) reasons.push("status_not_eligible");
  if (!issue.assigneeAgentId) reasons.push("missing_assignee");

  if (reasons.length > 0) {
    return { eligible: false, signals: [], reasons };
  }

  const signals: EligibilitySignal[] = [];

  // 1. Triggering comment is an agent question.
  if (trigger.kind === "comment.created") {
    if (commentIsFromAgent(trigger.comment) && commentLooksLikeQuestion(trigger.comment.body)) {
      signals.push("agent_question");
    }
  }

  // 2. Status just transitioned to blocked.
  if (
    trigger.kind === "issue.status_changed" &&
    trigger.previousStatus !== "blocked" &&
    trigger.newStatus === "blocked"
  ) {
    signals.push("transitioned_to_blocked");
  }

  // 3. A run finished in the last hour and status/assignee did not change since.
  if (input.lastRunFinishedAt) {
    const ageMs = now.getTime() - input.lastRunFinishedAt.getTime();
    if (ageMs >= 0 && ageMs <= ONE_HOUR_MS) {
      const changedAt = input.statusOrAssigneeChangedAt;
      if (!changedAt || changedAt <= input.lastRunFinishedAt) {
        signals.push("run_finished_no_change");
      }
    }
  }

  // 4. updatedAt older than 4 hours AND last comment is from an agent.
  const issueAgeMs = now.getTime() - issue.updatedAt.getTime();
  if (
    issueAgeMs > FOUR_HOURS_MS &&
    input.latestComment &&
    commentIsFromAgent(input.latestComment)
  ) {
    signals.push("stale_after_agent_comment");
  }

  // 5. At least one unresolved blocker is itself stuck (cap depth 1).
  if (input.blockers && input.blockers.some((b) => b.status !== "done" && b.status !== "cancelled" && b.stuck)) {
    signals.push("stuck_blocker");
  }

  if (signals.length === 0) {
    return { eligible: false, signals: [], reasons: ["no_signal"] };
  }
  return { eligible: true, signals, reasons: [] };
}
