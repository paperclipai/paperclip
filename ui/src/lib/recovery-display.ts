import type { IssueRecoveryAction } from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";

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

export function deriveRecoveryDisplayState(
  action: Pick<IssueRecoveryAction, "status" | "kind" | "outcome">,
): RecoveryDisplayState {
  if (action.status === "resolved") return "resolved";
  if (action.status === "escalated") return "escalated";
  if (action.status === "cancelled") return "resolved";
  if (action.kind === "active_run_watchdog") return "observe_only";
  if (action.outcome === "delegated") return "in_progress";
  return "needed";
}

export function deriveActiveRecoveryDisplayState(
  action: Pick<IssueRecoveryAction, "status" | "kind" | "outcome">,
): ActiveRecoveryDisplayState | null {
  const state = deriveRecoveryDisplayState(action);
  return state === "resolved" ? null : state;
}
