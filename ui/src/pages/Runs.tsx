import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunListItem as SharedRunListItem } from "../components/RunListItem";
import { RunDetailPanel } from "../components/RunDetailPanel";
import { SOURCE_FILTER_OPTIONS } from "../lib/run-utils";
import { cn, agentRouteRef } from "../lib/utils";
import { invocationSourceBadge, invocationSourceBadgeDefault } from "../lib/status-colors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Play, ArrowLeft } from "lucide-react";
import { Link } from "@/lib/router";
import type { HeartbeatRun, Agent } from "@paperclipai/shared";

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
  const { isMobile } = useSidebar();
  const { runId: urlRunId } = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

  useEffect(() => {
    const crumbs: Array<{ label: string; to?: string }> = [{ label: "Runs", to: "/runs" }];
    if (urlRunId) crumbs.push({ label: urlRunId.slice(0, 8) });
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, urlRunId]);

  const { data: runsResult, isLoading } = useQuery({
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

  const liveRuns = useMemo(
    () => filtered.filter((r) => r.status === "running" || r.status === "queued"),
    [filtered],
  );

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

  const effectiveRunId = urlRunId ?? (isMobile ? null : filtered[0]?.id ?? null);
  const selectedRun = filtered.find((r) => r.id === effectiveRunId) ?? null;

  // Mobile: if a run is selected, show only its detail panel
  if (isMobile && urlRunId && selectedRun) {
    return (
      <div className="space-y-3 min-w-0 overflow-x-hidden animate-page-enter">
        <Link
          to="/runs"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to runs
        </Link>
        <RunDetailPanel
          run={selectedRun}
          agent={agentMap.get(selectedRun.agentId)}
        />
      </div>
    );
  }

  const filterBar = (
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
  );

  // Mobile: list only (no split panel)
  if (isMobile) {
    return (
      <div className="space-y-4 animate-page-enter">
        {degraded && <DegradedBanner />}
        {liveRuns.length > 0 && <LiveRunsIndicator count={liveRuns.length} />}
        {filterBar}
        {filtered.length === 0 ? (
          <EmptyState icon={Play} message="No runs match the current filters." />
        ) : (
          <div className="border border-border rounded-lg overflow-x-hidden">
            {filtered.map((run) => (
              <SharedRunListItem
                key={run.id}
                run={run}
                isSelected={false}
                linkTo={`/runs/${run.id}`}
                agentName={agentMap.get(run.agentId)?.name}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Desktop: split panel — list on left, detail on right
  return (
    <div className="space-y-4 animate-page-enter">
      {degraded && <DegradedBanner />}
      {liveRuns.length > 0 && <LiveRunsIndicator count={liveRuns.length} />}
      {filterBar}

      {filtered.length === 0 ? (
        <EmptyState icon={Play} message="No runs match the current filters." />
      ) : (
        <div className="flex gap-0">
          {/* Run list */}
          <div className={cn(
            "shrink-0 border border-border rounded-lg",
            selectedRun ? "w-72" : "w-full",
          )}>
            <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
              {filtered.map((run) => (
                <SharedRunListItem
                  key={run.id}
                  run={run}
                  isSelected={run.id === effectiveRunId}
                  linkTo={`/runs/${run.id}`}
                  deselectTo="/runs"
                  agentName={agentMap.get(run.agentId)?.name}
                />
              ))}
            </div>
          </div>

          {/* Detail panel */}
          {selectedRun && (
            <div className="flex-1 min-w-0 pl-4">
              <RunDetailPanel
                key={selectedRun.id}
                run={selectedRun}
                agent={agentMap.get(selectedRun.agentId)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DegradedBanner() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
      <span className="shrink-0">⚠</span>
      <span>Some runs contain corrupted output data. Details may be incomplete.</span>
    </div>
  );
}

function LiveRunsIndicator({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-700 dark:text-cyan-300">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
      </span>
      <span className="font-medium">{count} run{count !== 1 ? "s" : ""} active now</span>
    </div>
  );
}
