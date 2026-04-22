import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardCheck, Settings } from "lucide-react";
import type { AgentServiceHealth } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { agentServiceHealthApi } from "../api/agentServiceHealth";
import { queryKeys } from "../lib/queryKeys";

function summarizeLatestFailure(health: AgentServiceHealth) {
  const failure = health.failureExamples[0];
  if (!failure) return null;
  const reason = failure.errorCode || failure.error || failure.status;
  return `${failure.agentName}: ${reason}`;
}

function summarizeBoardWarning(health: AgentServiceHealth) {
  const warning = health.boardIssueWarnings[0];
  if (!warning) return null;
  const label = warning.identifier ?? warning.title;
  return `${label}: ${warning.message}`;
}

export function AgentServiceHealthBanner() {
  const healthQuery = useQuery({
    queryKey: queryKeys.instance.agentServiceHealth,
    queryFn: () => agentServiceHealthApi.get(),
    retry: false,
    refetchInterval: 30_000,
  });

  if (healthQuery.isError || healthQuery.data?.status !== "down") {
    return null;
  }

  const health = healthQuery.data;
  const latestFailure = summarizeLatestFailure(health);
  const boardWarning = summarizeBoardWarning(health);
  const firstBoardWarning = health.boardIssueWarnings[0];
  const isBoardWarningOnly = health.reason === "stale_in_review_issues" || health.reason === "agent_completion_gaps";
  const actionHref = isBoardWarningOnly && firstBoardWarning
    ? `/${firstBoardWarning.companyIssuePrefix}/issues`
    : "/instance/settings/heartbeats";
  const ActionIcon = isBoardWarningOnly ? ClipboardCheck : Settings;
  const actionLabel = isBoardWarningOnly ? "Review board" : "Heartbeats";
  const toneClasses = isBoardWarningOnly
    ? {
        shell: "border-b border-amber-400/45 bg-amber-500/10 text-amber-200 dark:bg-amber-500/15",
        muted: "text-amber-100/75",
        link: "border-amber-300/35 bg-background/70 text-amber-100 hover:bg-background",
      }
    : {
        shell: "border-b border-destructive/45 bg-destructive/10 text-destructive dark:bg-destructive/15",
        muted: "text-destructive/75",
        link: "border-destructive/35 bg-background/70 text-destructive hover:bg-background",
      };

  return (
    <div
      role="alert"
      className={toneClasses.shell}
    >
      <div className="flex flex-col gap-2 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{isBoardWarningOnly ? "Board Review Needed" : "AI Agent Service Down"}</span>
          </div>
          <p className="mt-1 text-sm">
            {health.message}
            {latestFailure ? (
              <span className="text-destructive/85"> Latest failure: {latestFailure}</span>
            ) : null}
            {boardWarning ? (
              <span className={isBoardWarningOnly ? "text-amber-100/85" : "text-destructive/85"}>
                {" "}Board warning: {boardWarning}
              </span>
            ) : null}
          </p>
          <div className={`mt-1 flex flex-wrap items-center gap-2 text-xs ${toneClasses.muted}`}>
            <span>{health.counts.schedulerActiveAgentCount} scheduler-active</span>
            <span>{health.counts.eligibleAgentCount} eligible agents</span>
            {health.counts.stuckQueuedRunCount > 0 ? (
              <span>{health.counts.stuckQueuedRunCount} queued too long</span>
            ) : null}
            {health.counts.recentRuntimeFailureAgentCount > 0 ? (
              <span>{health.counts.recentRuntimeFailureAgentCount} agents failing recently</span>
            ) : null}
            {health.counts.staleInReviewIssueCount > 0 ? (
              <span>{health.counts.staleInReviewIssueCount} manual review needed</span>
            ) : null}
            {health.counts.completionGapIssueCount > 0 ? (
              <span>{health.counts.completionGapIssueCount} evidence missing</span>
            ) : null}
          </div>
        </div>

        <Link
          to={actionHref}
          className={`inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneClasses.link}`}
        >
          <ActionIcon className="h-3.5 w-3.5" />
          {actionLabel}
        </Link>
      </div>
    </div>
  );
}
