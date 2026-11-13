import { SERVER_RESTART_RETRY_MAX_ATTEMPTS, SERVER_RESTART_RETRY_WINDOW_MS } from "../execution-recovery-attempt.js";

/**
 * The assigned-work invariant. Every open task assigned to an agent (`todo`,
 * `in_progress`, or `blocked` where the block is not a person's to resolve)
 * has, at all times, exactly one of:
 *
 * 1. a live run (queued or running) whose owner is not proven gone;
 * 2. a durable pending intent that will start one (a queued wake, a scheduled
 *    retry, a monitor check, a native recovery the coordinator still owns, a
 *    pending hand-off);
 * 3. a named, user-visible reason it is waiting that is truly someone else's
 *    move. The list is closed (`WAITING_REASONS`): anything not on it is not a
 *    reason to wait.
 *
 * Anything else is a violation, and the assigned-work sweep repairs it with
 * one ordinary continuation wake. This module is pure: facts in, verdict out.
 */

/** Clause 2: a durable intent that will start a run without anyone acting. */
export const PENDING_INTENTS = [
  "queued_wake",
  "scheduled_retry",
  "scheduled_monitor",
  "native_recovery",
  "pending_handoff",
  "session_goal",
  "system_recovery_working",
] as const;
export type PendingIntent = (typeof PENDING_INTENTS)[number];

/** Clause 3: the closed list of waits that are someone else's move. */
export const WAITING_REASONS = [
  "question",
  "approval",
  "dependency",
  "review",
  "provider_limit",
  "budget",
  "credential",
  "agent_paused",
  "company_paused",
  "user_stop",
  "assignee_declared_block",
  "conversation",
  "awaiting_first_message",
  "board_confirmation",
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export const VIOLATION_REASONS = [
  /** A run row says running but its owning server is proven gone. */
  "run_owner_gone",
  /** A native run still says running, waiting for evidence or a reattach
   * that no live owner will deliver: no renewal for NATIVE_STALL_MS. It holds
   * its agent's slot. Reported; its ending belongs to native recovery. */
  "native_run_stalled",
  /** Open, assigned, nothing running, nothing pending, no one else's move. */
  "no_pending_path",
  /** The visible state offers a Retry that only the system can act on. */
  "retry_offered",
  /** Blocked by an automatic recovery outcome, not by a person. */
  "recovery_block",
  /** Blocked, and nothing recorded says why. */
  "unknown_block",
] as const;
export type ViolationReason = (typeof VIOLATION_REASONS)[number];

/** A run's owner, judged by the shared owner proof (owner-proof.ts). */
export type RunOwnerVerdict = "alive" | "gone" | "unprovable" | "stalled";

/** How long a native restart-recovery claim may go without renewal before
 * its run no longer counts as live. */
export const NATIVE_STALL_MS = 5 * 60_000;

/** Interruption presentation `userAction`s that are a person's move. */
const PERSON_ACTIONS: Readonly<Record<string, WaitingReason>> = {
  approval: "approval",
  reconnect: "credential",
  choose_model: "credential",
  project_access: "credential",
  assign_agent: "agent_paused",
  budget: "budget",
  resume: "agent_paused",
  confirm_owner_stop: "board_confirmation",
  confirm_run_stopped: "board_confirmation",
};

/** Active recovery-action causes that name a person's move. Every other cause
 * (stranded work, interrupted sessions, unknown codes) is a recovery outcome. */
const WAITING_RECOVERY_CAUSES: Readonly<Record<string, WaitingReason>> = {
  configuration_incomplete: "credential",
  ownership_owner_unprovable: "board_confirmation",
};
/** Provider usage limits are a wait only while a resume time is known. */
const PROVIDER_LIMIT_CAUSES = new Set(["provider_quota", "native_provider_usage_limit"]);

/** How long a just-finished run may still be settling (retry scheduling,
 * claim release) before its task is judged. A re-check follows at the end. */
export const SETTLING_GRACE_MS = 90_000;
/** Upper bound on how long another server's lease can keep a finished run settling. */
export const SETTLING_MAX_MS = 5 * 60_000;
export const SYSTEM_RECOVERY_WORKING_BOUND_MS = 17 * 60_000;
/** Blocked tasks older than this are reported, never continued automatically. */
export const STALE_BLOCK_MS = 7 * 24 * 60 * 60_000;
/** Automatic continuations per task, shared with the server-restart lane. */
export const CONTINUATION_CAP = SERVER_RESTART_RETRY_MAX_ATTEMPTS;
export const CONTINUATION_CAP_WINDOW_MS = SERVER_RESTART_RETRY_WINDOW_MS;
/** Spacing between continuations of one task, doubling with each one in the window. */
export const CONTINUATION_BASE_BACKOFF_MS = 2 * 60_000;
/** Spacing never exceeds this below the cap, so a task that keeps needing
 * continuation is retried at the hourly cap's pace, never left for hours. */
export const CONTINUATION_MAX_BACKOFF_MS = 15 * 60_000;

export type AssignedWorkFacts = {
  issue: {
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    hidden: boolean;
    blockedTransitionAt: Date | null;
    updatedAt: Date;
    /** When the task was created; a task that never ran settles from it. */
    createdAt?: Date | null;
    /** Owner of the agent's declared unblock action, when it declared one. */
    unblockOwner: { agentId: string } | { userId: string } | "board" | null;
    monitorNextCheckAt: Date | null;
    isConversation: boolean;
    awaitingFirstMessage: boolean;
  };
  /** Non-terminal runs (queued, running, scheduled_retry) for this task. */
  activeRuns: Array<{ id: string; status: string; scheduledRetryAt: Date | null; owner: RunOwnerVerdict }>;
  latestRun: {
    id: string;
    status: string;
    errorCode: string | null;
    finishedAt: Date | null;
    /** Another server still holds this run's controller lease to settle it. */
    settlingUntil: Date | null;
    operatorStopped: boolean;
  } | null;
  pendingWakes: number;
  nativeRecoveryPending: boolean;
  pendingHandoff: boolean;
  sessionGoal: "active" | "paused" | null;
  /** The user-visible interruption projection (task-interruption-presentation.ts). */
  interruption: {
    responsibility: "system" | "user";
    state: string;
    userAction: string | null;
    nextRetryAt: string | null;
    canRetry: boolean;
  } | null;
  pendingInteractions: number;
  pendingApprovals: number;
  openBlockers: number;
  /** When the task's most recent blocker was finished, if any. */
  lastBlockerResolvedAt?: Date | null;
  openChildren: number;
  reviewPending: boolean;
  activeRecoveryAction: { cause: string; ownerType: string; resumeAt: Date | null } | null;
  agent: { status: string; invokable: boolean } | null;
  companyPaused: boolean;
  pauseHold: boolean;
  budgetStop: boolean;
  /** Who moved the task to `blocked`, from its activity. */
  blockedBy: "user" | "assignee" | "system" | "unknown" | null;
};

export type AssignedWorkVerdict =
  | { kind: "not_applicable" }
  | { kind: "ok"; clause: "live_run"; runId: string }
  | { kind: "ok"; clause: "pending_intent"; intent: PendingIntent }
  | { kind: "ok"; clause: "waiting"; reason: WaitingReason }
  | { kind: "settling"; recheckAt: Date }
  | { kind: "violation"; reason: ViolationReason; runId?: string; stale: boolean };

const IN_SCOPE_STATUSES = new Set(["todo", "in_progress", "blocked"]);

export function evaluateAssignedWork(facts: AssignedWorkFacts, now: Date = new Date()): AssignedWorkVerdict {
  const { issue } = facts;
  if (!IN_SCOPE_STATUSES.has(issue.status) || !issue.assigneeAgentId || issue.assigneeUserId || issue.hidden) {
    return { kind: "not_applicable" };
  }

  // 1. A live run with an owner that is not proven gone. An unprovable owner
  // fails closed: during a deploy overlap another server may still own it.
  const live = facts.activeRuns.find(run => (run.status === "queued" || run.status === "running")
    && run.owner !== "gone" && run.owner !== "stalled");
  if (live) return { kind: "ok", clause: "live_run", runId: live.id };

  // A run row still says running but its server is proven gone. It holds the
  // task's execution lock, so nothing pending can start until it is settled.
  const ownerGone = facts.activeRuns.find(run => run.status === "running" && run.owner === "gone");
  if (ownerGone) return { kind: "violation", reason: "run_owner_gone", runId: ownerGone.id, stale: false };
  const stalled = facts.activeRuns.find(run => run.status === "running" && run.owner === "stalled");
  if (stalled) return { kind: "violation", reason: "native_run_stalled", runId: stalled.id, stale: false };

  // 2. A durable intent that starts a run without anyone acting.
  const intent = pendingIntent(facts, now);
  if (intent) return { kind: "ok", clause: "pending_intent", intent };

  // A run that ended moments ago is still settling: its own failure path may
  // be scheduling the retry right now. Look again after the grace.
  const settling = settlingUntil(facts, now);
  if (settling) return { kind: "settling", recheckAt: settling };

  // 3. Someone else's move, from the closed list.
  const waiting = waitingReason(facts, now);
  if (waiting) return { kind: "ok", clause: "waiting", reason: waiting };

  if (issue.status === "blocked") {
    const blockedAt = issue.blockedTransitionAt ?? issue.updatedAt;
    const stale = now.getTime() - blockedAt.getTime() > STALE_BLOCK_MS;
    // An active recovery hold that is not a person's move (checked above)
    // names the block as a recovery outcome even when no activity says who.
    const recovery = facts.blockedBy === "system" || facts.activeRecoveryAction !== null;
    return { kind: "violation", reason: recovery ? "recovery_block" : "unknown_block", stale };
  }
  if (facts.interruption?.responsibility === "system" && facts.interruption.state === "failed" && facts.interruption.canRetry) {
    return { kind: "violation", reason: "retry_offered", stale: false };
  }
  return { kind: "violation", reason: "no_pending_path", stale: false };
}

function pendingIntent(facts: AssignedWorkFacts, now: Date): PendingIntent | null {
  if (facts.pendingWakes > 0) return "queued_wake";
  if (facts.activeRuns.some(run => run.status === "scheduled_retry")) return "scheduled_retry";
  if (facts.nativeRecoveryPending) return "native_recovery";
  if (facts.pendingHandoff) return "pending_handoff";
  if (facts.sessionGoal === "active") return "session_goal";
  if (facts.issue.monitorNextCheckAt && facts.issue.monitorNextCheckAt.getTime() > now.getTime()) return "scheduled_monitor";
  const interruption = facts.interruption;
  if (interruption?.responsibility === "system") {
    if (interruption.state === "working" && !(facts.latestRun?.finishedAt
      && now.getTime() - facts.latestRun.finishedAt.getTime() > SYSTEM_RECOVERY_WORKING_BOUND_MS)) return "system_recovery_working";
    if (interruption.state === "retry_scheduled" && interruption.nextRetryAt
      && Date.parse(interruption.nextRetryAt) > now.getTime()) return "scheduled_retry";
  }
  return null;
}

/** The owners of three specific events act on them first: a run's failure
 * path schedules its retry when the run ends, the stranded sweep dispatches a
 * new assignment, the dependency wake follows a resolved blocker. Each grants
 * SETTLING_GRACE_MS from its own event; routine touches (comments, reads,
 * labels) never count. A held controller lease can extend the run's window,
 * but never past SETTLING_MAX_MS after the run ended. */
function settlingUntil(facts: AssignedWorkFacts, now: Date): Date | null {
  const run = facts.latestRun;
  const candidates: number[] = [];
  if (run?.finishedAt) {
    const ended = run.finishedAt.getTime();
    candidates.push(ended + SETTLING_GRACE_MS);
    if (run.settlingUntil) candidates.push(Math.min(run.settlingUntil.getTime(), ended + SETTLING_MAX_MS));
  }
  // A task that never ran: its assignment was just created.
  if (!run && facts.issue.createdAt) candidates.push(facts.issue.createdAt.getTime() + SETTLING_GRACE_MS);
  if (facts.lastBlockerResolvedAt) candidates.push(facts.lastBlockerResolvedAt.getTime() + SETTLING_GRACE_MS);
  if (!candidates.length) return null;
  const until = Math.max(...candidates);
  return until > now.getTime() ? new Date(until) : null;
}

function waitingReason(facts: AssignedWorkFacts, now: Date): WaitingReason | null {
  const { issue, interruption } = facts;
  if (interruption?.responsibility === "user" && interruption.state === "waiting_for_user" && interruption.userAction) {
    const mapped = PERSON_ACTIONS[interruption.userAction];
    if (mapped) return mapped;
  }
  if (facts.pendingInteractions > 0) return "question";
  if (facts.pendingApprovals > 0) return "approval";
  if (facts.openBlockers > 0 || facts.openChildren > 0) return "dependency";
  if (facts.reviewPending) return "review";
  if (facts.budgetStop) return "budget";
  if (facts.companyPaused) return "company_paused";
  if (facts.pauseHold || !facts.agent || !facts.agent.invokable) return "agent_paused";
  if (facts.sessionGoal === "paused") return "user_stop";
  if (facts.latestRun?.operatorStopped) return "user_stop";
  const action = facts.activeRecoveryAction;
  if (action) {
    const mapped = WAITING_RECOVERY_CAUSES[action.cause];
    if (mapped) return mapped;
    if (PROVIDER_LIMIT_CAUSES.has(action.cause) && action.resumeAt && action.resumeAt.getTime() > now.getTime()) {
      return "provider_limit";
    }
  }
  if (issue.isConversation) return "conversation";
  if (issue.awaitingFirstMessage) return "awaiting_first_message";
  if (issue.status === "blocked") {
    if (facts.blockedBy === "user") return "user_stop";
    const owner = issue.unblockOwner;
    const declaredForSomeoneElse = owner !== null
      && !(typeof owner === "object" && "agentId" in owner && owner.agentId === issue.assigneeAgentId);
    if (declaredForSomeoneElse || facts.blockedBy === "assignee") return "assignee_declared_block";
  }
  return null;
}

/** Spacing and cap for automatic continuations of one task. `recent` are the
 * times of its earlier automatic continuations. At most CONTINUATION_CAP per
 * rolling hour (the server-restart lane's bound). Below the cap the spacing
 * doubles with each continuation in the hour, 2, 4, 8 and then 15 minutes at
 * most. At the cap the next one waits until the oldest leaves the hour. */
export function continuationAllowance(recent: Date[], now: Date = new Date()):
  { allowed: true } | { allowed: false; retryAt: Date; capped: boolean } {
  const inWindow = recent.filter(at => at.getTime() > now.getTime() - CONTINUATION_CAP_WINDOW_MS)
    .sort((a, b) => b.getTime() - a.getTime());
  if (inWindow.length >= CONTINUATION_CAP) {
    const oldest = inWindow[CONTINUATION_CAP - 1];
    return { allowed: false, capped: true, retryAt: new Date(oldest.getTime() + CONTINUATION_CAP_WINDOW_MS) };
  }
  if (inWindow.length > 0) {
    const spacing = Math.min(CONTINUATION_MAX_BACKOFF_MS, CONTINUATION_BASE_BACKOFF_MS * 2 ** (inWindow.length - 1));
    const next = inWindow[0].getTime() + spacing;
    if (next > now.getTime()) return { allowed: false, capped: false, retryAt: new Date(next) };
  }
  return { allowed: true };
}

/** Activity text while a continuation is being admitted, and when admission refused it. */
export const CONTINUATION_PENDING_MESSAGE = "Starting this task again automatically after an interruption.";
export const CONTINUATION_REVIEW_MESSAGE =
  "Returned to review automatically after an interruption. Nothing needed you, so the review picks up where it stopped.";
export const CONTINUATION_REFUSED_MESSAGE =
  "Paperclip tried to continue this task automatically, but it could not start yet. It will try again shortly.";

/** Plain-language activity text for an admitted continuation. No codes, no ids. */
export function continuationActivityMessage(reason: ViolationReason): string {
  switch (reason) {
    case "native_run_stalled":
    case "run_owner_gone":
      return "Continued automatically: the server running this task stopped, so Paperclip queued it again.";
    case "recovery_block":
    case "unknown_block":
      return "Continued automatically after an interruption. Nothing needed you, so Paperclip queued the task again.";
    case "retry_offered":
      return "Continued automatically after an interruption. Paperclip queued the task again, so you don't need to press Retry.";
    default:
      return "Continued automatically after an interruption. Nothing was running or scheduled, so Paperclip queued the task again.";
  }
}
