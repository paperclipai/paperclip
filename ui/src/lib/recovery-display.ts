import type { IssueRecoveryAction, IssueRecoveryActionKind } from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";
import {
  readRecoveryRetryLineage,
  type RecoveryLivenessContext,
  type RecoveryRetryLineage,
} from "./recovery-lineage";

export type RecoveryDisplayState =
  | "needed"
  | "in_progress"
  | "observe_only"
  | "escalated"
  | "resolved";

export type ActiveRecoveryDisplayState = Exclude<RecoveryDisplayState, "resolved">;

export const RECOVERY_CHIP_DEFAULT_TONE: Record<
  ActiveRecoveryDisplayState,
  { className: string; icon: typeof TriangleAlert; label: string }
> = {
  needed: {
    className:
      "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    icon: TriangleAlert,
    label: "Recovery needed",
  },
  in_progress: {
    className:
      "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    icon: RefreshCw,
    label: "Recovery in progress",
  },
  observe_only: {
    className: "border-border bg-muted text-muted-foreground",
    icon: Eye,
    label: "Observing active run",
  },
  escalated: {
    className: "border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-300",
    icon: OctagonAlert,
    label: "Recovery escalated",
  },
};

/**
 * Every surface derives its recovery tone from this one function, so a source issue and
 * the parent views that list it as a blocker never disagree about whether recovery is
 * quietly running or actually needs a human.
 */
export type RecoveryDisplayInput = Pick<IssueRecoveryAction, "status" | "kind" | "outcome"> &
  Partial<
    Pick<IssueRecoveryAction, "wakePolicy" | "evidence" | "attemptCount" | "maxAttempts" | "timeoutAt">
  >;

export function deriveRecoveryDisplayState(
  action: RecoveryDisplayInput,
  context?: RecoveryLivenessContext,
): RecoveryDisplayState {
  if (action.status === "resolved") return "resolved";
  if (action.status === "escalated") return "escalated";
  if (action.status === "cancelled") return "resolved";
  if (action.kind === "active_run_watchdog") return "observe_only";
  // A bounded retry lineage still holding a durable path is work the server will do on its
  // own. Shouting "recovery needed" over it would ask a human to fix something nobody has to
  // fix yet, so the calm tone is reserved for a lane with an attempt genuinely still coming.
  // Once that attempt comes due unanswered, or the budget runs out, the warning is the honest
  // state — nothing is going to move this task without someone stepping in.
  const lineage = readRecoveryRetryLineage({
    wakePolicy: action.wakePolicy ?? null,
    evidence: action.evidence,
    attemptCount: action.attemptCount,
    maxAttempts: action.maxAttempts,
    timeoutAt: action.timeoutAt,
  }, context);
  if (lineage && lineage.lane !== "board" && lineage.hasDurablePath) return "in_progress";
  if (action.outcome === "delegated") return "in_progress";
  return "needed";
}

export function deriveActiveRecoveryDisplayState(
  action: RecoveryDisplayInput,
  context?: RecoveryLivenessContext,
): ActiveRecoveryDisplayState | null {
  const state = deriveRecoveryDisplayState(action, context);
  return state === "resolved" ? null : state;
}

export function recoveryChipLabel(
  state: ActiveRecoveryDisplayState,
  kind: IssueRecoveryActionKind,
  lineage?: RecoveryRetryLineage | null,
): string {
  if (kind === "workspace_validation" && state === "needed") {
    return "Workspace recovery needed";
  }
  if (
    state === "in_progress" &&
    lineage &&
    lineage.maxAttempts !== null &&
    lineage.attempt > 0
  ) {
    return `Recovery in progress · ${Math.min(lineage.attempt, lineage.maxAttempts)}/${lineage.maxAttempts}`;
  }
  return RECOVERY_CHIP_DEFAULT_TONE[state].label;
}
