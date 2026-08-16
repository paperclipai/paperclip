import type { IssueRecoveryAction, IssueRecoveryActionKind } from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";

export type RecoveryDisplayState =
  | "needed"
  | "in_progress"
  | "observe_only"
  | "escalated"
  | "resolved";

export type ActiveRecoveryDisplayState = Exclude<RecoveryDisplayState, "resolved">;

const RECOVERY_DISPLAY_STATES = new Set<string>([
  "needed",
  "in_progress",
  "observe_only",
  "escalated",
  "resolved",
]);

export const RECOVERY_CHIP_DEFAULT_TONE: Record<
  ActiveRecoveryDisplayState,
  { className: string; icon: typeof TriangleAlert; label: string; recessed: boolean }
> = {
  // `amber-800`, not `amber-700`: every chip renders at --text-nano (10px), so
  // 4.5:1 is the bar. amber-700 on `bg-amber-500/15` measures 4.49:1 and fails;
  // amber-800 measures 6.34:1 and keeps the same warning hue (PAP-17083).
  needed: {
    className:
      "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-300",
    icon: TriangleAlert,
    label: "Recovery needed",
    recessed: false,
  },
  // Recessed on purpose: a recovery owner is already live or queued, so this is
  // progress reporting, not a call to action. Prominent amber/red is reserved
  // for `needed` (no owner/path) and `escalated` (a decision is truly required).
  //
  // Recession is carried by the NEUTRAL hue, never by low contrast:
  // `text-muted-foreground` on solid `bg-muted` measured 4.34:1 at 10px and
  // failed WCAG AA (PAP-17061 finding 3). `--recessed-foreground` is the
  // AA-tuned neutral for exactly this pairing — 5.99:1, same quiet grey read.
  in_progress: {
    className: "border-border bg-muted text-recessed-foreground",
    icon: RefreshCw,
    label: "Recovery in progress",
    recessed: true,
  },
  observe_only: {
    className: "border-border bg-muted text-recessed-foreground",
    icon: Eye,
    label: "Observing active run",
    recessed: true,
  },
  escalated: {
    className: "border-red-500/60 bg-red-500/15 text-red-800 dark:text-red-300",
    icon: OctagonAlert,
    label: "Recovery escalated",
    recessed: false,
  },
};

/** States that render as a quiet, foldable line instead of a prominent card. */
export function isRecessedRecoveryState(state: RecoveryDisplayState): boolean {
  return state === "in_progress" || state === "observe_only" || state === "resolved";
}

/**
 * Liveness a surface knows about the *source* task and the recovery owner.
 *
 * Recovery classification is only honest when it accounts for who is actually
 * running: a recovery action whose owner is mid-run is "in progress", and a
 * newer durable source-owner path invalidates a stale recovery action. Surfaces
 * pass whatever they have; every field is optional and absence means "unknown"
 * (which degrades to the pre-liveness classification).
 */
export interface RecoveryLivenessSignals {
  /**
   * A run the surface is already rendering (e.g. the run card in the active-agents
   * panel). Counts as recovery-owner liveness when its agent owns the action.
   */
  ownerRun?: { agentId?: string | null; status?: string | null } | null;
  /** The source task holds a live/queued execution run. */
  sourceHasLiveRun?: boolean;
  /** Agent behind the source task's live run, when known. */
  sourceLiveRunAgentId?: string | null;
  /** A queued wake (scheduled retry) is pending on the source task. */
  hasQueuedWake?: boolean;
  /** The successful-run handoff projection reports a live continuation. */
  hasLiveContinuation?: boolean;
}

const LIVE_RUN_STATUSES = new Set(["queued", "running"]);
const QUEUED_WAKE_STATUSES = new Set(["scheduled_retry", "queued", "running"]);

/** Shape of the fields `recoveryLivenessFromIssue` reads; satisfied by `Issue`/`CompactIssue`. */
export interface RecoveryLivenessIssueLike {
  id?: string;
  status?: string | null;
  executionRunId?: string | null;
  assigneeAgentId?: string | null;
  scheduledRetry?: { status?: string | null } | null;
  successfulRunHandoff?: { hasLiveContinuation?: boolean } | null;
}

/**
 * Derives liveness from an issue payload alone — the execution lock, the queued
 * retry, and the successful-run handoff projection. Surfaces with richer run
 * data (a live run list, a rendered run card) should merge it in via `extra`.
 */
export function recoveryLivenessFromIssue(
  issue: RecoveryLivenessIssueLike | null | undefined,
  extra?: RecoveryLivenessSignals,
): RecoveryLivenessSignals {
  const sourceHasLiveRun = Boolean(issue?.executionRunId);
  const retryStatus = issue?.scheduledRetry?.status ?? null;
  return {
    sourceHasLiveRun,
    sourceLiveRunAgentId: sourceHasLiveRun ? issue?.assigneeAgentId ?? null : null,
    hasQueuedWake: retryStatus ? QUEUED_WAKE_STATUSES.has(retryStatus) : false,
    hasLiveContinuation: issue?.successfulRunHandoff?.hasLiveContinuation ?? false,
    ...extra,
  };
}

/**
 * The server-side recovery projection (`displayState`), read defensively.
 *
 * The owner-sticky recovery contract publishes the authoritative state on the
 * action itself. Until every deployment emits it the field is absent, so the
 * client derivation below stands in — but whenever the server does project a
 * state, it wins over anything inferred here.
 */
function readProjectedState(action: object): RecoveryDisplayState | null {
  const projected = (action as { displayState?: unknown }).displayState;
  return typeof projected === "string" && RECOVERY_DISPLAY_STATES.has(projected)
    ? (projected as RecoveryDisplayState)
    : null;
}

type RecoveryActionForDisplay = Pick<IssueRecoveryAction, "status" | "kind" | "outcome"> &
  Partial<Pick<IssueRecoveryAction, "ownerAgentId" | "recoveryIssueId">>;

function ownerRunIsLive(
  action: RecoveryActionForDisplay,
  signals: RecoveryLivenessSignals | undefined,
): boolean {
  const run = signals?.ownerRun;
  if (!run) return false;
  if (!run.status || !LIVE_RUN_STATUSES.has(run.status)) return false;
  // An unattributed run can't be proven to be the recovery owner's.
  if (!action.ownerAgentId || !run.agentId) return false;
  return run.agentId === action.ownerAgentId;
}

export function deriveRecoveryDisplayState(
  action: RecoveryActionForDisplay,
  signals?: RecoveryLivenessSignals,
): RecoveryDisplayState {
  const projected = readProjectedState(action);
  if (projected) return projected;

  if (action.status === "resolved") return "resolved";
  if (action.status === "cancelled") return "resolved";
  // The watchdog never asks for a decision — it exists to observe a live run.
  if (action.kind === "active_run_watchdog" && action.status !== "escalated") {
    return "observe_only";
  }
  // A proven live/queued run by the recovery owner outranks escalation: the
  // escalation already found an owner and that owner is working it.
  if (ownerRunIsLive(action, signals)) return "in_progress";
  if (action.status === "escalated") return "escalated";
  if (signals?.sourceHasLiveRun) {
    const ownerIsRunning =
      Boolean(action.ownerAgentId) && signals.sourceLiveRunAgentId === action.ownerAgentId;
    // Someone other than the recovery owner is live on the source task — a newer
    // durable source-owner path that folds this action down to observation.
    return ownerIsRunning ? "in_progress" : "observe_only";
  }
  if (signals?.hasQueuedWake) return "in_progress";
  if (action.outcome === "delegated") return "in_progress";
  if (action.recoveryIssueId) return "in_progress";
  if (signals?.hasLiveContinuation) return "observe_only";
  return "needed";
}

export function deriveActiveRecoveryDisplayState(
  action: RecoveryActionForDisplay,
  signals?: RecoveryLivenessSignals,
): ActiveRecoveryDisplayState | null {
  const state = deriveRecoveryDisplayState(action, signals);
  return state === "resolved" ? null : state;
}

/** Minimal run shape the presentation derivation needs; `LiveRunForIssue` satisfies it. */
export interface RecoveryLivenessRun {
  agentId?: string | null;
  agentName?: string | null;
  status?: string | null;
}

export interface RecoveryPresentation {
  state: RecoveryDisplayState;
  /** Name of the live/queued recovery owner, when resolvable. */
  ownerName: string | null;
  /** True when the surface should render the recessed line instead of the card. */
  recessed: boolean;
}

/**
 * One derivation shared by every task thread: classify the action against the
 * task's live runs, queued wake, and handoff projection, and resolve the owner's
 * display name for the "Recovery in progress · CTO" line.
 */
export function deriveRecoveryPresentation(input: {
  action: RecoveryActionForDisplay | null | undefined;
  liveRuns?: readonly RecoveryLivenessRun[];
  issueId?: string | null;
  liveIssueIds?: ReadonlySet<string> | null;
  issueAssigneeAgentId?: string | null;
  scheduledRetry?: { status?: string | null } | null;
  successfulRunHandoff?: { hasLiveContinuation?: boolean } | null;
  resolveAgentName?: (agentId: string) => string | null | undefined;
}): RecoveryPresentation | null {
  const { action } = input;
  if (!action) return null;
  const liveRuns = (input.liveRuns ?? []).filter(
    (run) => run.status === "queued" || run.status === "running",
  );
  const ownerRun = action.ownerAgentId
    ? liveRuns.find((run) => run.agentId === action.ownerAgentId) ?? null
    : null;
  const sourceRun = liveRuns[0] ?? null;
  const state = deriveRecoveryDisplayState(
    action,
    recoveryLivenessFromIssue(
      {
        scheduledRetry: input.scheduledRetry ?? null,
        successfulRunHandoff: input.successfulRunHandoff ?? null,
      },
      {
        ownerRun: ownerRun ? { agentId: ownerRun.agentId, status: ownerRun.status } : null,
        sourceHasLiveRun:
          liveRuns.length > 0 || Boolean(input.issueId && input.liveIssueIds?.has(input.issueId)),
        sourceLiveRunAgentId: sourceRun?.agentId ?? input.issueAssigneeAgentId ?? null,
      },
    ),
  );
  const ownerName =
    ownerRun?.agentName ??
    (action.ownerAgentId ? input.resolveAgentName?.(action.ownerAgentId) ?? null : null);
  return { state, ownerName, recessed: isRecessedRecoveryState(state) };
}

export function recoveryChipLabel(
  state: ActiveRecoveryDisplayState,
  kind: IssueRecoveryActionKind,
  options?: { ownerName?: string | null },
): string {
  if (kind === "workspace_validation" && state === "needed") {
    return "Workspace recovery needed";
  }
  const label = RECOVERY_CHIP_DEFAULT_TONE[state].label;
  const ownerName = options?.ownerName?.trim();
  // "Recovery in progress · CTO" — naming the live owner is what makes the
  // recessed line legible without expanding it.
  return state === "in_progress" && ownerName ? `${label} · ${ownerName}` : label;
}
