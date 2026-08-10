import type {
  Approval,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  IssueThreadInteraction,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { isSuccessfulRunHandoffRequired } from "../../lib/successful-run-handoff";
// Type-only import — erases at compile time, so this module stays pure (no React).
import type { StatusGlyphStatus } from "../StatusGlyph";

/**
 * The single "what needs you now" verdict for a task, resolved from props
 * already in scope on the thread (no fetch, no React). It powers the sticky
 * Decision / Next action bar (TaskDecisionBar) — the per-task mirror of the
 * global Decision Queue.
 *
 * The nine kinds form a strict priority ladder: {@link resolveTaskNextAction}
 * returns the FIRST rung that matches, so a blocked task waiting on a recovery
 * action reports "recovery", not "blocked".
 */
export type TaskNextActionKind =
  | "recovery"
  | "blocked"
  | "approval"
  | "interaction"
  | "retry"
  | "handoff"
  | "review"
  | "working"
  | "clear";

/**
 * Tone borrows the Decision Queue's two-kind vocabulary (see
 * `lib/attention.ts` — blocking → task status `blocked`, review → `in_review`)
 * plus a third `positive` tone for the two dopamine states (working / clear).
 */
export type TaskNextActionTone = "blocking" | "review" | "positive";

/** Which existing banner a rung's `expand` CTA discloses inside a Curtain. */
export type TaskDecisionShelf = "recovery" | "blocked" | "retry" | "handoff";

export type TaskNextActionCta =
  | { type: "expand"; shelf: TaskDecisionShelf; label: string }
  | { type: "href"; href: string; label: string }
  /** `targetId` is a `data-item-id` (e.g. `interaction:<id>`), or null for "latest". */
  | { type: "scroll"; targetId: string | null; label: string };

export interface TaskNextAction {
  kind: TaskNextActionKind;
  tone: TaskNextActionTone;
  title: string;
  cta?: TaskNextActionCta;
}

export interface TaskNextActionInput {
  issueId?: string | null;
  issueStatus?: string | null;
  recoveryAction?: IssueRecoveryAction | null;
  /** Full blocker list; the resolver counts the ones not done/cancelled. */
  blockedBy?: readonly Pick<IssueRelationIssueSummary, "status">[] | null;
  pendingApproval?: Pick<Approval, "id"> | null;
  interactions?: readonly Pick<IssueThreadInteraction, "id" | "status">[] | null;
  scheduledRetry?: IssueScheduledRetry | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  /** Company-wide set of issue ids with a live (queued/running) run. */
  liveIssueIds?: ReadonlySet<string> | null;
  hasLiveRun?: boolean;
  agentName?: string | null;
}

/**
 * StatusGlyph status each kind borrows — the same glyph vocabulary the global
 * Decision Queue uses (`ATTENTION_KIND_STATUS` in `lib/attention.ts`): blocking
 * rungs → `blocked`, review rungs → `in_review`. The two positive rungs extend
 * it: an in-flight run reads `in_progress`, a caught-up task reads `done`.
 */
export const TASK_NEXT_ACTION_GLYPH: Record<TaskNextActionKind, StatusGlyphStatus> = {
  recovery: "blocked",
  blocked: "blocked",
  approval: "in_review",
  interaction: "in_review",
  retry: "blocked",
  handoff: "blocked",
  review: "in_review",
  working: "in_progress",
  clear: "done",
};

/**
 * Resolve the one action a task most needs from the viewer right now. FIRST
 * match on the priority ladder wins (see {@link TaskNextActionKind}).
 */
export function resolveTaskNextAction(input: TaskNextActionInput): TaskNextAction {
  const {
    issueId = null,
    issueStatus = null,
    recoveryAction = null,
    blockedBy = null,
    pendingApproval = null,
    interactions = null,
    scheduledRetry = null,
    successfulRunHandoff = null,
    liveIssueIds = null,
    hasLiveRun = false,
    agentName = null,
  } = input;

  // 1 — recovery: a recovery action always trumps everything else.
  if (recoveryAction != null) {
    return {
      kind: "recovery",
      tone: "blocking",
      title: "Recovery needed",
      cta: { type: "expand", shelf: "recovery", label: "Review" },
    };
  }

  // 2 — blocked: an unresolved blocker, or an explicitly blocked status.
  const unresolvedBlockers = (blockedBy ?? []).filter(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );
  if (unresolvedBlockers.length > 0 || issueStatus === "blocked") {
    const count = unresolvedBlockers.length;
    return {
      kind: "blocked",
      tone: "blocking",
      title: count > 0 ? `Blocked by ${count} ${count === 1 ? "task" : "tasks"}` : "Blocked",
      cta: { type: "expand", shelf: "blocked", label: "View blockers" },
    };
  }

  // 3 — approval: a pending approval deep-links to its detail surface.
  if (pendingApproval != null) {
    return {
      kind: "approval",
      tone: "review",
      title: "Approval needed",
      cta: { type: "href", href: `/approvals/${pendingApproval.id}`, label: "Review" },
    };
  }

  // 4 — interaction: a pending inline thread interaction (question / confirm).
  const pendingInteraction = (interactions ?? []).find((interaction) => interaction.status === "pending");
  if (pendingInteraction) {
    return {
      kind: "interaction",
      tone: "review",
      title: "Your input is needed",
      cta: { type: "scroll", targetId: `interaction:${pendingInteraction.id}`, label: "Respond" },
    };
  }

  // 5 — retry: a scheduled (not yet promoted) automatic retry.
  if (scheduledRetry?.status === "scheduled_retry") {
    return {
      kind: "retry",
      tone: "blocking",
      title: "Retry scheduled",
      cta: { type: "expand", shelf: "retry", label: "View retry" },
    };
  }

  // 6 — handoff: a successful run that still needs a disposition, and nothing
  // is currently live on the issue (mirrors the IssueBlockedNotice guard).
  const handoffRequired =
    successfulRunHandoff != null
    && isSuccessfulRunHandoffRequired({ successfulRunHandoff, scheduledRetry: scheduledRetry ?? undefined })
    && !(issueId != null && (liveIssueIds?.has(issueId) ?? false));
  if (handoffRequired) {
    return {
      kind: "handoff",
      tone: "blocking",
      title: "This task needs a next step",
      cta: { type: "expand", shelf: "handoff", label: "Choose next step" },
    };
  }

  // 7 — review: the task is waiting on a human review verdict.
  if (issueStatus === "in_review") {
    return {
      kind: "review",
      tone: "review",
      title: "Ready for your review",
      cta: { type: "scroll", targetId: null, label: "Jump to latest" },
    };
  }

  // 8 — working: an agent is actively on it. Positive, no CTA.
  if (hasLiveRun) {
    return {
      kind: "working",
      tone: "positive",
      title: `On track — ${agentName ?? "agent"} is working`,
    };
  }

  // 9 — clear: nothing needs the viewer.
  return {
    kind: "clear",
    tone: "positive",
    title: "You're all caught up — nothing needs you.",
  };
}
