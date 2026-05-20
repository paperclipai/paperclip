import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, DashboardTokenUsageRange } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatNumber, formatTokens } from "../lib/utils";

const RANGE_OPTIONS: Array<{ value: DashboardTokenUsageRange; label: string; subtitle: string }> = [
  { value: "daily", label: "Daily", subtitle: "Last 7 days" },
  { value: "weekly", label: "Weekly", subtitle: "Last 8 weeks" },
  { value: "monthly", label: "Monthly", subtitle: "Last 6 months" },
];

interface TokenUsageDashboardCardProps {
  companyId: string;
  agents: Agent[];
}

function resolveScopeLabel(agentId: string | null, agentsById: Map<string, Agent>) {
  if (!agentId) return "All agents";
  return agentsById.get(agentId)?.name ?? "Selected agent";
}

export function TokenUsageDashboardCard({ companyId, agents }: TokenUsageDashboardCardProps) {
  const [range, setRange] = useState<DashboardTokenUsageRange>("monthly");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  useEffect(() => {
    if (selectedAgentId && !agentsById.has(selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [agentsById, selectedAgentId]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboardTokenUsage(companyId, range, selectedAgentId),
    queryFn: () => dashboardApi.tokenUsage(companyId, { range, agentId: selectedAgentId }),
    enabled: !!companyId,
  });

  const maxBucketTokens = Math.max(1, ...(data?.buckets.map((bucket) => bucket.totalTokens) ?? [0]));
  const hasTokenData = (data?.totals.totalTokens ?? 0) > 0;
  const scopeLabel = data?.scope.label ?? resolveScopeLabel(selectedAgentId, agentsById);
  const rangeSubtitle = RANGE_OPTIONS.find((option) => option.value === range)?.subtitle ?? "";

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">Token Usage</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Scope: {scopeLabel} - Range: {rangeSubtitle} - Timezone: UTC
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRange(option.value)}
                className={cn(
                  "px-2.5 py-1.5 text-xs transition-colors",
                  range === option.value
                    ? "bg-foreground text-background"
                    : "bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Agent</span>
            <select
              value={selectedAgentId ?? "all"}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedAgentId(value === "all" ? null : value);
              }}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              <option value="all">All agents</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading ? <p className="text-xs text-muted-foreground">Loading token usage...</p> : null}
      {error ? <p className="text-xs text-destructive">Failed to load token usage: {error.message}</p> : null}

      {!isLoading && !error && data ? (
        <>
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Total Tokens</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{formatTokens(data.totals.totalTokens)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Input {formatTokens(data.totals.inputTokens)} - Cached {formatTokens(data.totals.cachedInputTokens)} - Output {formatTokens(data.totals.outputTokens)}
            </p>
            <p className="text-xs text-muted-foreground">{formatNumber(data.totals.runCount)} runs in selected range</p>
          </div>

          {!hasTokenData ? (
            <p className="text-xs text-muted-foreground">No token usage data for the selected scope and range.</p>
          ) : (
            <div className="space-y-2">
              {data.buckets.map((bucket) => {
                const width = Math.max(2, (bucket.totalTokens / maxBucketTokens) * 100);
                return (
                  <div key={bucket.key} className="space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">{bucket.label}</span>
                      <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                        <div className="h-full bg-sky-500" style={{ width: `${width}%` }} />
                      </div>
                      <span className="w-20 text-right text-xs font-mono text-foreground">{formatTokens(bucket.totalTokens)}</span>
                    </div>
                    <p className="pl-24 text-[11px] text-muted-foreground">
                      {formatNumber(bucket.runCount)} runs - in {formatTokens(bucket.inputTokens)} - cached {formatTokens(bucket.cachedInputTokens)} - out {formatTokens(bucket.outputTokens)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
