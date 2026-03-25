import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, relativeTime, formatTokens, agentRouteRef } from "../lib/utils";
import { invocationSourceLabel, invocationSourceBadge, invocationSourceBadgeDefault } from "../lib/status-colors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
} from "lucide-react";
import type { HeartbeatRun, Agent } from "@paperclipai/shared";

const runStatusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function runMetrics(run: HeartbeatRun) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = (run.resultJson ?? null) as Record<string, unknown> | null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cost =
    usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
    usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
  return { input, output, cost, totalTokens: input + output };
}

const SOURCE_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "timer", label: "Timer" },
  { value: "assignment", label: "Assignment" },
  { value: "on_demand", label: "On-demand" },
  { value: "automation", label: "Automation" },
  { value: "chat", label: "Chat" },
] as const;

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "queued", label: "Queued" },
  { value: "cancelled", label: "Cancelled" },
  { value: "timed_out", label: "Timed out" },
] as const;

export function Runs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Runs" }]);
  }, [setBreadcrumbs]);

  const { data: runsResult, isLoading, error } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 500),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const runs = runsResult?.runs ?? [];
  const degraded = runsResult?.degraded ?? false;

  const filtered = useMemo(() => {
    let list = runs.filter((r): r is HeartbeatRun => r != null);
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
    if (sourceFilter !== "all") list = list.filter((r) => r.invocationSource === sourceFilter);
    if (agentFilter !== "all") list = list.filter((r) => r.agentId === agentFilter);
    return list.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [runs, statusFilter, sourceFilter, agentFilter]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Play} message="Select a company to view runs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const agentsWithRuns = [...new Set(runs.map((r) => r.agentId))].sort((a, b) => {
    const nameA = agentMap.get(a)?.name ?? a;
    const nameB = agentMap.get(b)?.name ?? b;
    return nameA.localeCompare(nameB);
  });

  return (
    <div className="space-y-4 animate-page-enter">
      {degraded && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          <span className="shrink-0">⚠</span>
          <span>Some runs contain corrupted output data. Details may be incomplete.</span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {SOURCE_FILTER_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setSourceFilter(value)}
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                sourceFilter === value
                  ? value === "all"
                    ? "bg-foreground text-background"
                    : (invocationSourceBadge[value] ?? invocationSourceBadgeDefault)
                  : "bg-muted/60 text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {agentsWithRuns.length > 1 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentsWithRuns.map((id) => (
                  <SelectItem key={id} value={id}>
                    {agentMap.get(id)?.name ?? id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_OPTIONS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {filtered.length === 0 && !isLoading && (
        <EmptyState icon={Play} message="No runs match the current filters." />
      )}

      {filtered.length > 0 && (
        <div className="border border-border rounded-lg divide-y divide-border">
          {filtered.map((run) => (
            <RunRow key={run.id} run={run} agent={agentMap.get(run.agentId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, agent }: { run: HeartbeatRun; agent?: Agent }) {
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";

  const agentRef = agent ? agentRouteRef(agent) : run.agentId;

  return (
    <Link
      to={`/agents/${agentRef}/runs/${run.id}`}
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/30 no-underline text-inherit"
    >
      <StatusIcon
        className={cn(
          "h-4 w-4 shrink-0 mt-0.5",
          statusInfo.color,
          run.status === "running" && "animate-spin",
        )}
      />

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
          <StatusBadge status={run.status} />
          <span
            className={cn(
              "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
              invocationSourceBadge[run.invocationSource] ?? invocationSourceBadgeDefault,
            )}
          >
            {invocationSourceLabel[run.invocationSource] ?? run.invocationSource}
          </span>
        </div>

        {summary && (
          <p className="text-xs text-muted-foreground truncate">{summary.slice(0, 120)}</p>
        )}

        {(metrics.totalTokens > 0 || metrics.cost > 0) && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
            {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
            {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
          </div>
        )}
      </div>

      <div className="shrink-0 text-right space-y-1">
        {agent && (
          <span className="text-xs font-medium text-foreground/80 block">{agent.name}</span>
        )}
        <span className="text-[11px] text-muted-foreground block tabular-nums">
          {relativeTime(run.createdAt)}
        </span>
      </div>
    </Link>
  );
}
