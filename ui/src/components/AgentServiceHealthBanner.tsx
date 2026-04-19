import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Settings } from "lucide-react";
import type { AgentServiceHealth } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { agentServiceHealthApi } from "../api/agentServiceHealth";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

function summarizeLatestFailure(health: AgentServiceHealth) {
  const failure = health.failureExamples[0];
  if (!failure) return null;
  const reason = failure.error ?? failure.errorCode ?? failure.status;
  return `${failure.agentName}: ${reason}`;
}

export function AgentServiceHealthBanner() {
  const healthQuery = useQuery({
    queryKey: queryKeys.instance.agentServiceHealth,
    queryFn: () => agentServiceHealthApi.get(),
    retry: false,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  if (healthQuery.error instanceof ApiError && healthQuery.error.status === 403) return null;
  if (healthQuery.error || !healthQuery.data || healthQuery.data.status === "healthy") return null;

  const health = healthQuery.data;
  const latestFailure = summarizeLatestFailure(health);

  return (
    <div
      role="alert"
      className="border-b border-destructive/45 bg-destructive/10 text-destructive dark:bg-destructive/15"
    >
      <div className="flex flex-col gap-2 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>AI Agent Service Down</span>
          </div>
          <p className="mt-1 text-sm">
            {health.message}
            {latestFailure ? (
              <span className="text-destructive/85"> Latest failure: {latestFailure}</span>
            ) : null}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive/75">
            <span>{health.counts.schedulerActiveAgentCount} scheduler-active</span>
            <span>{health.counts.eligibleAgentCount} eligible agents</span>
            {health.counts.stuckQueuedRunCount > 0 ? (
              <span>{health.counts.stuckQueuedRunCount} stuck queued</span>
            ) : null}
            {health.counts.recentRuntimeFailureAgentCount > 0 ? (
              <span>{health.counts.recentRuntimeFailureAgentCount} agents failing recently</span>
            ) : null}
          </div>
        </div>

        <Link
          to="/instance/settings/heartbeats"
          className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-destructive/35 bg-background/70 px-3 text-xs font-medium text-destructive transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings className="h-3.5 w-3.5" />
          Heartbeats
        </Link>
      </div>
    </div>
  );
}
