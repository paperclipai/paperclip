import { useQuery } from "@tanstack/react-query";
import { Ban, Clock, LifeBuoy, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  deriveNextAction,
  type NextActionAccent,
  type NextActionLane,
} from "../lib/next-action";

/** Left-accent hue per lane. All values are tokens — never raw color literals. */
const ACCENT_VAR: Record<NextActionAccent, string> = {
  in_progress: "var(--status-task-in_progress)",
  in_review: "var(--status-task-in_review)",
  todo: "var(--status-task-todo)",
  blocked: "var(--status-task-blocked)",
  recovery_amber: "var(--status-task-todo)",
  recovery_sky: "var(--status-task-in_progress)",
  recovery_red: "var(--status-task-blocked)",
  none: "var(--border)",
};

const LANE_ICON: Record<NextActionLane, LucideIcon> = {
  working_now: Play,
  recovery: LifeBuoy,
  waiting_decision: Clock,
  blocked_real_work: Ban,
  none: Clock,
};

export interface RunNextActionVerdictProps {
  issueId: string;
  /** True when the surfacing run is itself live against this issue. */
  runIsActive?: boolean;
  className?: string;
}

/**
 * Compact, single-line next-action verdict for a run surface. Reuses the same
 * four-lane resolver as the issue-detail panel so a
 * run drawer answers "what moves this task forward next?" without re-deriving
 * it. Renders nothing when the task is on track or terminal.
 */
export function RunNextActionVerdict({ issueId, runIsActive, className }: RunNextActionVerdictProps) {
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: Boolean(issueId),
    staleTime: 15_000,
  });

  if (!issue) return null;

  const summary = deriveNextAction({
    status: issue.status,
    blockedInboxAttention: issue.blockedInboxAttention ?? null,
    activeRecoveryAction: issue.activeRecoveryAction ?? null,
    scheduledRetry: issue.scheduledRetry ?? null,
    successfulRunHandoff: issue.successfulRunHandoff ?? null,
    hasLiveRun: runIsActive,
  });

  if (summary.lane === "none") return null;

  const accent = ACCENT_VAR[summary.accent];
  const Icon = LANE_ICON[summary.lane];

  return (
    <div
      role="status"
      data-testid="run-next-action-verdict"
      data-next-action-lane={summary.lane}
      style={{ borderLeftColor: accent, borderLeftWidth: "var(--sz-3px)" }}
      className={`flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs ${className ?? ""}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} aria-hidden />
      <span
        className="shrink-0 text-(length:--text-nano) font-semibold uppercase tracking-wide"
        style={{ color: accent }}
      >
        {summary.laneLabel}
      </span>
      <span className="truncate font-medium text-foreground">{summary.statement}</span>
    </div>
  );
}
