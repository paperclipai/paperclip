import type { HeartbeatIssueExecutionSummary } from "@paperclipai/shared";

export type IssueExecutionIndicator = {
  label: string;
  title: string;
  tone: "live" | "quiet" | "pending";
  pulse?: boolean;
};

function formatExecutionAge(ageMs: number) {
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function resolveIssueExecutionIndicator(
  summary: HeartbeatIssueExecutionSummary | null | undefined,
  isLiveFallback: boolean,
): IssueExecutionIndicator | null {
  if (summary?.activeRun) {
    const agentLabel = summary.activeRun.agentName ?? "assignee";
    if (summary.activeRun.status === "queued") {
      const ageLabel =
        summary.activeRun.freshness === "quiet"
          ? ` ${formatExecutionAge(summary.activeRun.activityAgeMs)}`
          : "";
      return {
        label: `Queued${ageLabel}`,
        title: `Execution is queued for ${agentLabel}.`,
        tone: summary.activeRun.freshness === "quiet" ? "quiet" : "pending",
      };
    }

    if (summary.activeRun.freshness === "fresh") {
      return {
        label: "Live",
        title: `${agentLabel} is actively executing this issue.`,
        tone: "live",
        pulse: true,
      };
    }

    const ageLabel = formatExecutionAge(summary.activeRun.activityAgeMs);
    return {
      label: `Quiet ${ageLabel}`,
      title: `${agentLabel} still owns this run, but it has not reported fresh activity for ${ageLabel}.`,
      tone: "quiet",
    };
  }

  if (summary?.latestWakeup) {
    switch (summary.latestWakeup.status) {
      case "queued":
      case "claimed":
        return {
          label: "Waking",
          title: "A wakeup request is in flight for this issue.",
          tone: "pending",
        };
      case "deferred_issue_execution":
        return {
          label: "Wake deferred",
          title: "This wakeup is deferred until the current issue execution slot is released.",
          tone: "pending",
        };
      case "coalesced":
        return {
          label: "Wake merged",
          title: "This wakeup was merged into an existing run for the same issue.",
          tone: "pending",
        };
      case "skipped":
        return {
          label: "Wake skipped",
          title:
            summary.latestWakeup.reason === "heartbeat.live_run_limit_reached"
              ? "This wakeup was skipped because the assignee is already at its live-run limit."
              : summary.latestWakeup.error ?? "This wakeup was skipped by runtime policy.",
          tone: "quiet",
        };
      default:
        break;
    }
  }

  if (!isLiveFallback) return null;
  return {
    label: "Live",
    title: "This issue has fresh live execution activity.",
    tone: "live",
    pulse: true,
  };
}

export function issueExecutionIndicatorClassName(tone: IssueExecutionIndicator["tone"]) {
  switch (tone) {
    case "live":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "quiet":
      return "bg-amber-500/12 text-amber-700 dark:text-amber-300";
    case "pending":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}
