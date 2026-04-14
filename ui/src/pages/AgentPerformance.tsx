import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { agentMemoryApi } from "../api/agentMemory";
import { issuesApi } from "../api/issues";
import { costsApi } from "../api/costs";
import { projectsApi } from "../api/projects";
import { velocityApi } from "../api/velocity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, cn, agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Link } from "@/lib/router";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ArrowDown, ArrowUp, Award, BarChart3, Building2, Download, Medal, TrendingDown } from "lucide-react";
import { DEPARTMENT_LABELS } from "@ironworksai/shared";
import { exportToCSV } from "../lib/exportCSV";

// Components
import {
  computeAgentPerformance,
  computeRating,
  RATING_COLORS,
  type AgentPerfRow,
  type SortField,
  type TimeRange,
} from "../components/performance/ratingUtils";
import { CompanyKpiCards } from "../components/performance/CompanyKpiCards";
import { PerformanceInsights } from "../components/performance/PerformanceInsights";
import { PerformanceTable } from "../components/performance/PerformanceTable";
import {
  PerformanceTrendChart,
  VelocityChart,
} from "../components/performance/PerformanceCharts";
import {
  WorkloadDistribution,
  AgentPipeline,
  PerformanceByProject,
} from "../components/performance/WorkloadCharts";

// Prevent lint from removing imports used only in JSX
const _usedIcons = { ArrowDown, ArrowUp, Award, Building2, Download, Medal };

// Re-export for consumers (e.g. BoardBriefing)
export type { AgentPerfRow };
export { computeAgentPerformance };

export function AgentPerformance() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [range, setRange] = useState<TimeRange>("30d");
  const [sortField, setSortField] = useState<SortField>("rating");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [trendAgentId, setTrendAgentId] = useState<string>("");
  const [showDeptAgg, setShowDeptAgg] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agent Performance" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: costsByAgent } = useQuery({
    queryKey: [...queryKeys.costs(selectedCompanyId!), "by-agent"],
    queryFn: () => costsApi.byAgent(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: velocity } = useQuery({
    queryKey: queryKeys.velocity(selectedCompanyId!, 12),
    queryFn: () => velocityApi.get(selectedCompanyId!, 12),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const effectiveTrendAgentId = trendAgentId || (agents?.[0]?.id ?? "");

  const { data: trendMemory } = useQuery({
    queryKey: queryKeys.agentMemory.list(selectedCompanyId!, effectiveTrendAgentId),
    queryFn: () => agentMemoryApi.list(selectedCompanyId!, effectiveTrendAgentId),
    enabled: !!selectedCompanyId && !!effectiveTrendAgentId,
    staleTime: 60_000,
  });

  const trendSnapshots = useMemo(() => {
    if (!trendMemory) return [];
    return trendMemory
      .filter((m) => m.category === "performance_snapshot")
      .map((m) => {
        let score: number | null = null;
        try {
          const parsed = JSON.parse(m.content) as Record<string, unknown>;
          const s = parsed.score ?? parsed.performance_score ?? parsed.ratingScore;
          if (typeof s === "number") score = Math.min(100, Math.max(0, s));
        } catch {
          const match = m.content.match(/\b(\d{1,3})\b/);
          if (match) score = Math.min(100, Math.max(0, Number(match[1])));
        }
        return { date: new Date(m.createdAt), score };
      })
      .filter((s): s is { date: Date; score: number } => s.score !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(-12);
  }, [trendMemory]);

  const rows = useMemo(
    () => computeAgentPerformance(agents ?? [], issues ?? [], costsByAgent ?? [], range),
    [agents, issues, costsByAgent, range],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortField === "rating") {
        return dir * a.rating.localeCompare(b.rating);
      }
      const av = a[sortField] ?? -1;
      const bv = b[sortField] ?? -1;
      return dir * ((av as number) - (bv as number));
    });
  }, [rows, sortField, sortDir]);

  const prevRows = useMemo(() => {
    if (range === "all") return [];
    const days = range === "7d" ? 7 : 30;
    const now = Date.now();
    const prevIssues = (issues ?? []).filter((i) => {
      const t = new Date(i.updatedAt).getTime();
      return t > now - days * 2 * 24 * 60 * 60 * 1000 && t <= now - days * 24 * 60 * 60 * 1000;
    });
    return computeAgentPerformance(agents ?? [], prevIssues, costsByAgent ?? [], "all");
  }, [agents, issues, costsByAgent, range]);

  const prevScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of prevRows) m.set(r.agentId, r.ratingScore);
    return m;
  }, [prevRows]);

  const deptAggRows = useMemo(() => {
    if (!showDeptAgg) return [];
    const deptMap = new Map<string, { dept: string; agents: AgentPerfRow[] }>();
    for (const row of rows) {
      const agent = (agents ?? []).find((a) => a.id === row.agentId);
      const dept = (agent as unknown as Record<string, unknown> | undefined)?.department as string | undefined ?? "unassigned";
      if (!deptMap.has(dept)) deptMap.set(dept, { dept, agents: [] });
      deptMap.get(dept)!.agents.push(row);
    }
    return Array.from(deptMap.values()).map((g) => {
      const active = g.agents.filter((r) => r.tasksDone > 0);
      return {
        dept: g.dept,
        agentCount: g.agents.length,
        avgScore: active.length > 0 ? Math.round(active.reduce((s, r) => s + r.ratingScore, 0) / active.length) : 0,
        totalDone: g.agents.reduce((s, r) => s + r.tasksDone, 0),
        avgThroughput: active.length > 0 ? +(active.reduce((s, r) => s + r.throughput, 0) / active.length).toFixed(2) : 0,
        avgCompletion: active.length > 0 ? Math.round(active.reduce((s, r) => s + r.completionRate, 0) / active.length) : 0,
        totalSpend: g.agents.reduce((s, r) => s + r.totalSpendCents, 0),
      };
    }).sort((a, b) => b.avgScore - a.avgScore);
  }, [rows, agents, showDeptAgg]);

  const topPerformer = rows.filter((r) => r.tasksDone > 0)[0] ?? null;
  const mostImproved = useMemo(() => {
    if (prevRows.length === 0) return null;
    let best: AgentPerfRow | null = null;
    let bestDelta = -Infinity;
    for (const row of rows) {
      const prev = prevScoreMap.get(row.agentId);
      if (prev !== undefined && row.tasksDone > 0) {
        const delta = row.ratingScore - prev;
        if (delta > bestDelta) { bestDelta = delta; best = row; }
      }
    }
    return bestDelta > 0 ? best : null;
  }, [rows, prevRows, prevScoreMap]);

  const teamAvgScore = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.ratingScore, 0) / rows.length) : 0;
  const teamRating = computeRating(teamAvgScore);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={BarChart3} message="Select a company to view agent performance." />;
  }

  if (agentsLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Performance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Evaluate agent efficiency, throughput, and cost effectiveness.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors",
              showDeptAgg ? "bg-accent text-foreground border-foreground/20" : "border-border text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowDeptAgg(!showDeptAgg)}
          >
            <_usedIcons.Building2 className="h-3.5 w-3.5" />
            Departments
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => {
              exportToCSV(
                rows.map((r) => ({
                  name: r.name,
                  rating: r.rating,
                  score: r.ratingScore,
                  tasksDone: r.tasksDone,
                  tasksInProgress: r.tasksInProgress,
                  throughput: r.throughput.toFixed(2),
                  avgCloseH: r.avgCloseH !== null ? r.avgCloseH.toFixed(1) : "",
                  costPerTask: r.costPerTask !== null ? (r.costPerTask / 100).toFixed(2) : "",
                  totalSpend: (r.totalSpendCents / 100).toFixed(2),
                  completionRate: r.completionRate,
                })),
                `agent-performance-${range}`,
                [
                  { key: "name", label: "Agent" },
                  { key: "rating", label: "Rating" },
                  { key: "score", label: "Score" },
                  { key: "tasksDone", label: "Tasks Done" },
                  { key: "tasksInProgress", label: "In Progress" },
                  { key: "throughput", label: "Tasks/Day" },
                  { key: "avgCloseH", label: "Avg Close (hrs)" },
                  { key: "costPerTask", label: "Cost/Task ($)" },
                  { key: "totalSpend", label: "Total Spend ($)" },
                  { key: "completionRate", label: "Completion %" },
                ],
              );
            }}
          >
            <_usedIcons.Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <div
            className="flex items-center gap-1 border border-border rounded-md overflow-hidden"
            role="group"
            aria-label="Time range"
          >
            {(["7d", "30d", "all"] as const).map((r) => (
              <button
                key={r}
                className={cn(
                  "px-3 py-1.5 text-xs transition-colors",
                  range === r ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={range === r}
                onClick={() => setRange(r)}
              >
                {r === "all" ? "All time" : r === "7d" ? "7 days" : "30 days"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Performance Alert Banner */}
      {(() => {
        const bigDrops = rows.filter((r) => {
          const prev = prevScoreMap.get(r.agentId);
          return prev !== undefined && r.tasksDone > 0 && prev - r.ratingScore >= 15;
        });
        if (bigDrops.length === 0) return null;
        return (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/[0.04] px-4 py-3">
            <TrendingDown className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Significant rating changes detected</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {bigDrops.map((r) => {
                  const prev = prevScoreMap.get(r.agentId) ?? 0;
                  return `${r.name} dropped ${prev - r.ratingScore} points`;
                }).join("; ")}
              </p>
            </div>
          </div>
        );
      })()}

      {/* Leaderboard Highlights */}
      {(topPerformer || mostImproved) && (
        <div className="flex flex-wrap gap-3">
          {topPerformer && (
            <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5">
              <_usedIcons.Award className="h-5 w-5 text-amber-400 shrink-0" />
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">Top Performer</div>
                <div className="text-sm font-medium">{topPerformer.name} <span className="text-muted-foreground">- Score {topPerformer.ratingScore}</span></div>
              </div>
            </div>
          )}
          {mostImproved && (
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
              <_usedIcons.Medal className="h-5 w-5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">Most Improved</div>
                <div className="text-sm font-medium">
                  {mostImproved.name}
                  <span className="text-muted-foreground ml-1">
                    - Score {mostImproved.ratingScore}
                    {prevScoreMap.get(mostImproved.agentId) !== undefined && (
                      <span className="text-emerald-400 ml-1">
                        (+{mostImproved.ratingScore - (prevScoreMap.get(mostImproved.agentId) ?? 0)})
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Company-Level Aggregate KPIs */}
      <CompanyKpiCards rows={rows} />

      {/* Department Aggregation */}
      {showDeptAgg && deptAggRows.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <_usedIcons.Building2 className="h-3.5 w-3.5" />
              Department Averages
            </h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">Department</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase">Agents</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase">Avg Score</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase">Tasks Done</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase">Tasks/Day</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase">Completion</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase">Total Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deptAggRows.map((d) => {
                  const deptLabel = (DEPARTMENT_LABELS as Record<string, string>)[d.dept] ?? d.dept;
                  return (
                    <tr key={d.dept} className="hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-2.5 font-medium">{deptLabel}</td>
                      <td className="px-4 py-2.5 text-center tabular-nums">{d.agentCount}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={cn(
                          "inline-flex items-center justify-center h-6 w-6 rounded text-xs font-bold",
                          RATING_COLORS[computeRating(d.avgScore)],
                        )}>
                          {computeRating(d.avgScore)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">{d.totalDone}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{d.avgThroughput}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{d.avgCompletion}%</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCents(d.totalSpend)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Velocity Chart */}
      {velocity && velocity.length > 0 && (
        <div className="rounded-xl border border-border p-4 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mission Velocity - Last 12 Weeks</h4>
          <VelocityChart data={velocity} />
        </div>
      )}

      {/* Team summary */}
      <div className="flex items-center gap-4 rounded-xl border border-border p-4">
        <div className={cn("inline-flex items-center justify-center h-12 w-12 rounded-xl border text-xl font-bold", RATING_COLORS[teamRating])}>
          {teamRating}
        </div>
        <div>
          <p className="text-sm font-medium">Team Average</p>
          <p className="text-sm text-muted-foreground">
            {rows.filter((r) => r.tasksDone > 0).length} active agents · {rows.reduce((s, r) => s + r.tasksDone, 0)} tasks completed · {formatCents(rows.reduce((s, r) => s + r.totalSpendCents, 0))} total spend
          </p>
        </div>
      </div>

      {/* Per-Agent KPI Cards */}
      {sorted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sorted.slice(0, 6).map((row) => {
            const successRate = row.tasksDone > 0 ? row.completionRate : null;
            const successColor = successRate !== null
              ? successRate >= 85 ? "text-emerald-400" : successRate >= 70 ? "text-amber-400" : "text-red-400"
              : "text-muted-foreground";
            const prev = prevScoreMap.get(row.agentId);
            const delta = prev !== undefined ? row.ratingScore - prev : null;
            return (
              <div key={row.agentId} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "inline-flex items-center justify-center h-7 w-7 rounded-lg border text-xs font-bold",
                    RATING_COLORS[row.rating],
                  )}>
                    {row.rating}
                  </span>
                  <Link to={agentUrl({ id: row.agentId, urlKey: null, name: null })} className="no-underline text-inherit font-medium truncate">
                    {row.name}
                  </Link>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Success</p>
                    <p className={cn("text-lg font-bold tabular-nums", successColor)}>
                      {successRate !== null ? `${successRate}%` : "-"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">$/Task</p>
                    <p className="text-lg font-bold tabular-nums text-muted-foreground">
                      {row.costPerTask !== null ? formatCents(Math.round(row.costPerTask)) : "-"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Score</p>
                    <div className="flex items-center gap-1.5">
                      <p className="text-lg font-bold tabular-nums">{row.ratingScore}</p>
                      {delta !== null && delta !== 0 && (
                        delta > 0
                          ? <_usedIcons.ArrowUp className="h-3 w-3 text-emerald-400" />
                          : <_usedIcons.ArrowDown className="h-3 w-3 text-red-400" />
                      )}
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            row.ratingScore >= 80 ? "bg-emerald-500" : row.ratingScore >= 50 ? "bg-amber-500" : "bg-red-500",
                          )}
                          style={{ width: `${row.ratingScore}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Insights */}
      {rows.length > 0 && <PerformanceInsights rows={rows} />}

      {/* Performance Score Trend */}
      {rows.length > 0 && agents && agents.length > 0 && (
        <div className="rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Performance Score Trend</h4>
            <Select value={effectiveTrendAgentId} onValueChange={setTrendAgentId}>
              <SelectTrigger className="w-[200px] h-8 text-xs">
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.filter((a) => a.status !== "terminated").map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {trendSnapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No performance snapshots found. Agents write memory entries with category "performance_snapshot" to populate this chart.
            </p>
          ) : (
            <PerformanceTrendChart snapshots={trendSnapshots} />
          )}
        </div>
      )}

      {/* Main Table */}
      {sorted.length === 0 ? (
        <EmptyState icon={BarChart3} message="No agents to evaluate." />
      ) : (
        <PerformanceTable
          sorted={sorted}
          sortField={sortField}
          sortDir={sortDir}
          prevScoreMap={prevScoreMap}
          expandedRowId={expandedRowId}
          onToggleExpand={(id) => setExpandedRowId(expandedRowId === id ? null : id)}
          onToggleSort={toggleSort}
        />
      )}

      {/* Workload Distribution + Agent Pipeline */}
      {rows.length > 0 && issues && issues.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <WorkloadDistribution rows={rows} issues={issues} />
          <AgentPipeline rows={rows} issues={issues} />
        </div>
      )}

      {/* Performance by Project */}
      {rows.length > 0 && projects && projects.length > 0 && (
        <PerformanceByProject
          rows={rows}
          issues={issues ?? []}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
        />
      )}
    </div>
  );
}
