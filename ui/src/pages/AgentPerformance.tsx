import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { costsApi } from "../api/costs";
import { projectsApi } from "../api/projects";
import { velocityApi, type VelocityWeek } from "../api/velocity";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, cn, agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, BarChart3, CheckCircle2, Lightbulb, TrendingDown } from "lucide-react";
import type { Issue } from "@ironworksai/shared";

/* ── Rating logic ── */

export interface AgentPerfRow {
  agentId: string;
  name: string;
  status: string;
  tasksDone: number;
  tasksInProgress: number;
  throughput: number; // tasks per day
  avgCloseH: number | null;
  costPerTask: number | null; // cents
  totalSpendCents: number;
  completionRate: number; // 0-100
  rating: "A" | "B" | "C" | "D" | "F";
  ratingScore: number; // 0-100 composite
}

function computeRating(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

const RATING_COLORS: Record<string, string> = {
  A: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  B: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  C: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  D: "text-orange-400 bg-orange-500/10 border-orange-500/20",
  F: "text-red-400 bg-red-500/10 border-red-500/20",
};

type TimeRange = "7d" | "30d" | "all";

function isInRange(date: Date | string, range: TimeRange): boolean {
  if (range === "all") return true;
  const days = range === "7d" ? 7 : 30;
  return new Date(date).getTime() > Date.now() - days * 24 * 60 * 60 * 1000;
}

export function computeAgentPerformance(
  agents: Array<{ id: string; name: string; status: string }>,
  issues: Issue[],
  costsByAgent: Array<{ agentId: string; costCents: number }>,
  range: TimeRange,
): AgentPerfRow[] {
  const rangedIssues = range === "all" ? issues : issues.filter((i) => isInRange(i.updatedAt, range));
  const days = range === "7d" ? 7 : range === "30d" ? 30 : (() => {
    if (issues.length === 0) return 1;
    let earliest = Date.now();
    for (const i of issues) { const t = new Date(i.createdAt).getTime(); if (t < earliest) earliest = t; }
    return Math.max(1, Math.ceil((Date.now() - earliest) / (24 * 60 * 60 * 1000)));
  })();

  const rows: AgentPerfRow[] = [];

  for (const agent of agents) {
    if (agent.status === "terminated") continue;

    const agentIssues = rangedIssues.filter((i) => i.assigneeAgentId === agent.id);
    const done = agentIssues.filter((i) => i.status === "done");
    const inProgress = agentIssues.filter((i) => i.status === "in_progress");
    const cancelled = agentIssues.filter((i) => i.status === "cancelled");
    const tasksDone = done.length;
    const tasksInProgress = inProgress.length;
    const throughput = tasksDone / days;

    // Avg close time
    let totalCloseMs = 0;
    let closeCount = 0;
    for (const issue of done) {
      if (issue.startedAt && issue.completedAt) {
        totalCloseMs += new Date(issue.completedAt).getTime() - new Date(issue.startedAt).getTime();
        closeCount++;
      }
    }
    const avgCloseH = closeCount > 0 ? totalCloseMs / closeCount / (1000 * 60 * 60) : null;

    // Cost
    const agentCost = costsByAgent.find((c) => c.agentId === agent.id);
    const totalSpendCents = agentCost?.costCents ?? 0;
    const costPerTask = tasksDone > 0 ? totalSpendCents / tasksDone : null;

    // Completion rate
    const totalResolved = tasksDone + cancelled.length;
    const completionRate = totalResolved > 0 ? Math.round((tasksDone / totalResolved) * 100) : (tasksDone > 0 ? 100 : 0);

    rows.push({
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      tasksDone,
      tasksInProgress,
      throughput,
      avgCloseH,
      costPerTask,
      totalSpendCents,
      completionRate,
      rating: "C", // placeholder, computed below
      ratingScore: 0,
    });
  }

  // Compute composite score relative to team
  if (rows.length > 0) {
    const withTasks = rows.filter((r) => r.tasksDone > 0);
    const avgCost = withTasks.length > 0 ? withTasks.reduce((s, r) => s + (r.costPerTask ?? 0), 0) / withTasks.length : 0;
    const avgClose = withTasks.filter((r) => r.avgCloseH !== null).reduce((s, r) => s + r.avgCloseH!, 0) / (withTasks.filter((r) => r.avgCloseH !== null).length || 1);
    const maxThroughput = Math.max(...rows.map((r) => r.throughput), 0.001);

    for (const row of rows) {
      if (row.tasksDone === 0) {
        row.ratingScore = 0;
        row.rating = "F";
        continue;
      }

      // Cost efficiency (0-100, lower cost = higher score)
      const costScore = avgCost > 0 && row.costPerTask !== null
        ? Math.min(100, Math.max(0, 100 - ((row.costPerTask - avgCost) / avgCost) * 50))
        : 50;

      // Speed (0-100, faster = higher score)
      const speedScore = avgClose > 0 && row.avgCloseH !== null
        ? Math.min(100, Math.max(0, 100 - ((row.avgCloseH - avgClose) / avgClose) * 50))
        : 50;

      // Throughput (0-100, more tasks/day = higher)
      const throughputScore = Math.min(100, (row.throughput / maxThroughput) * 100);

      // Completion rate (0-100)
      const completionScore = row.completionRate;

      // Weighted composite
      const composite = Math.round(
        costScore * 0.25 +
        speedScore * 0.25 +
        throughputScore * 0.25 +
        completionScore * 0.25
      );

      row.ratingScore = composite;
      row.rating = computeRating(composite);
    }
  }

  return rows.sort((a, b) => b.ratingScore - a.ratingScore);
}

/* ── Component ── */

type SortField = "rating" | "tasksDone" | "throughput" | "avgCloseH" | "costPerTask" | "totalSpendCents" | "completionRate";

export function AgentPerformance() {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [range, setRange] = useState<TimeRange>("30d");
  const [sortField, setSortField] = useState<SortField>("rating");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

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

  const rows = useMemo(
    () => computeAgentPerformance(agents ?? [], issues ?? [], costsByAgent ?? [], range),
    [agents, issues, costsByAgent, range],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortField === "rating") {
        // Rating is A/B/C/D/F — sort alphabetically (A < B < ... < F)
        // desc = best first (A before F), asc = worst first (F before A)
        return dir * a.rating.localeCompare(b.rating);
      }
      const av = a[sortField] ?? -1;
      const bv = b[sortField] ?? -1;
      return dir * ((av as number) - (bv as number));
    });
  }, [rows, sortField, sortDir]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Performance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Evaluate agent efficiency, throughput, and cost effectiveness.
          </p>
        </div>
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

      {/* Company-Level Aggregate KPIs */}
      <CompanyKpiCards rows={rows} />

      {/* Velocity Chart */}
      {velocity && velocity.length > 0 && (
        <div className="rounded-xl border border-border p-4 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Issue Velocity - Last 12 Weeks</h4>
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
            return (
              <div key={row.agentId} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "inline-flex items-center justify-center h-7 w-7 rounded-lg border text-xs font-bold",
                    RATING_COLORS[row.rating],
                  )}>
                    {row.rating}
                  </span>
                  <Link to={agentUrl({ id: row.agentId, urlKey: null } as any)} className="no-underline text-inherit font-medium truncate">
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

      {/* Table */}
      {sorted.length === 0 ? (
        <EmptyState icon={BarChart3} message="No agents to evaluate." />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {/* Mobile card view */}
          <div className="md:hidden divide-y divide-border">
            {sorted.map((row) => (
              <div key={row.agentId} className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn("inline-flex items-center justify-center h-6 w-6 rounded border text-xs font-bold shrink-0", RATING_COLORS[row.rating])}>
                      {row.rating}
                    </span>
                    <Link to={agentUrl({ id: row.agentId, urlKey: null } as any)} className="no-underline text-inherit font-medium truncate">
                      {row.name}
                    </Link>
                  </div>
                  <span className="text-sm tabular-nums text-muted-foreground shrink-0">
                    {row.tasksDone} done{row.tasksInProgress > 0 && <span> +{row.tasksInProgress}</span>}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm tabular-nums">
                  <div>
                    <div className="text-xs text-muted-foreground/60">$/task</div>
                    <div className="text-muted-foreground">{row.costPerTask !== null ? formatCents(Math.round(row.costPerTask)) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground/60">Avg time</div>
                    <div className="text-muted-foreground">{row.avgCloseH !== null ? `${row.avgCloseH.toFixed(1)}h` : "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground/60">Completion</div>
                    <div className="text-muted-foreground">{row.completionRate}%</div>
                  </div>
                </div>
                {(row.rating === "D" || row.rating === "F") && row.tasksDone > 0 && (
                  <button
                    className="text-[10px] text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors"
                    onClick={() => openNewIssue({
                      title: `Performance Review: ${row.name} — rating ${row.rating}`,
                      description: `## Performance Improvement Plan\n\n**Agent:** ${row.name}\n**Current Rating:** ${row.rating}\n**Cost/Task:** ${row.costPerTask !== null ? formatCents(Math.round(row.costPerTask)) : "N/A"}\n**Avg Close Time:** ${row.avgCloseH !== null ? `${row.avgCloseH.toFixed(1)}h` : "N/A"}\n**Completion Rate:** ${row.completionRate}%\n\n### Recommended Actions\n\n- [ ] Review SOUL.md and AGENTS.md for clarity\n- [ ] Check if assigned tasks match agent's role\n- [ ] Consider switching to a more cost-effective model\n- [ ] Simplify task instructions\n- [ ] Re-evaluate after 1 week`,
                    })}
                  >
                    Create PIP
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Agent</th>
                  <SortHeader field="rating" label="Rating" current={sortField} dir={sortDir} onToggle={toggleSort} align="center" />
                  <SortHeader field="tasksDone" label="Done" current={sortField} dir={sortDir} onToggle={toggleSort} align="center" />
                  <SortHeader field="throughput" label="Tasks/Day" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="avgCloseH" label="Avg Time" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="costPerTask" label="$/Task" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="totalSpendCents" label="Total Spend" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="completionRate" label="Completion" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider w-20">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((row) => (
                  <tr key={row.agentId} className="hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={agentUrl({ id: row.agentId, urlKey: null } as any)} className="no-underline text-inherit">
                        <Identity name={row.name} size="sm" />
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={cn("inline-flex items-center justify-center h-7 w-7 rounded-lg border text-xs font-bold", RATING_COLORS[row.rating])}>
                        {row.rating}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center tabular-nums">
                      {row.tasksDone}
                      {row.tasksInProgress > 0 && (
                        <span className="text-muted-foreground ml-1">+{row.tasksInProgress}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {row.throughput > 0 ? row.throughput.toFixed(1) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {row.avgCloseH !== null ? `${row.avgCloseH.toFixed(1)}h` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {row.costPerTask !== null ? formatCents(Math.round(row.costPerTask)) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCents(row.totalSpendCents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              row.completionRate >= 80 ? "bg-emerald-500" : row.completionRate >= 50 ? "bg-amber-500" : "bg-red-500",
                            )}
                            style={{ width: `${row.completionRate}%` }}
                          />
                        </div>
                        <span className="text-sm text-muted-foreground tabular-nums w-8 text-right">{row.completionRate}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(row.rating === "D" || row.rating === "F") && row.tasksDone > 0 ? (
                        <button
                          className="text-[10px] text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors"
                          onClick={() => openNewIssue({
                            title: `Performance Review: ${row.name} — rating ${row.rating}`,
                            description: `## Performance Improvement Plan\n\n**Agent:** ${row.name}\n**Current Rating:** ${row.rating}\n**Cost/Task:** ${row.costPerTask !== null ? formatCents(Math.round(row.costPerTask)) : "N/A"}\n**Avg Close Time:** ${row.avgCloseH !== null ? `${row.avgCloseH.toFixed(1)}h` : "N/A"}\n**Completion Rate:** ${row.completionRate}%\n\n### Recommended Actions\n\n- [ ] Review SOUL.md and AGENTS.md for clarity\n- [ ] Check if assigned tasks match agent's role\n- [ ] Consider switching to a more cost-effective model\n- [ ] Simplify task instructions\n- [ ] Re-evaluate after 1 week`,
                          })}
                        >
                          Create PIP
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Workload Distribution + Agent Pipeline side by side */}
      {rows.length > 0 && issues && issues.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Workload Distribution */}
          <div className="rounded-xl border border-border p-4 space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workload Distribution</h4>
            <p className="text-sm text-muted-foreground">Active tasks per agent — identify overloaded or idle team members.</p>
            <div className="space-y-2.5">
              {(() => {
                const maxActive = Math.max(...rows.map((r) => r.tasksInProgress + (issues ?? []).filter((i) => i.assigneeAgentId === r.agentId && i.status === "todo").length), 1);
                return rows
                  .map((r) => {
                    const todo = (issues ?? []).filter((i) => i.assigneeAgentId === r.agentId && i.status === "todo").length;
                    const active = r.tasksInProgress + todo;
                    return { ...r, todo, active };
                  })
                  .sort((a, b) => b.active - a.active)
                  .map((r) => (
                    <div key={r.agentId} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate">{r.name}</span>
                        <span className="text-muted-foreground shrink-0">
                          {r.tasksInProgress} active · {r.todo} queued
                        </span>
                      </div>
                      <div className="flex h-2 rounded-full overflow-hidden bg-muted">
                        {r.tasksInProgress > 0 && (
                          <div
                            className="bg-blue-500 transition-[width] duration-300"
                            style={{ width: `${(r.tasksInProgress / maxActive) * 100}%` }}
                          />
                        )}
                        {r.todo > 0 && (
                          <div
                            className="bg-blue-500/30 transition-[width] duration-300"
                            style={{ width: `${(r.todo / maxActive) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                  ));
              })()}
            </div>
            <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-500" /> In Progress</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-500/30" /> Queued (Todo)</span>
            </div>
          </div>

          {/* Agent Pipeline */}
          <div className="rounded-xl border border-border p-4 space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Pipeline</h4>
            <p className="text-sm text-muted-foreground">Task funnel per agent — from backlog to done.</p>
            <div className="space-y-2">
              {rows.filter((r) => r.tasksDone > 0 || r.tasksInProgress > 0).map((r) => {
                const backlog = (issues ?? []).filter((i) => i.assigneeAgentId === r.agentId && i.status === "backlog").length;
                const todo = (issues ?? []).filter((i) => i.assigneeAgentId === r.agentId && i.status === "todo").length;
                const inProgress = r.tasksInProgress;
                const inReview = (issues ?? []).filter((i) => i.assigneeAgentId === r.agentId && i.status === "in_review").length;
                const done = r.tasksDone;
                const total = backlog + todo + inProgress + inReview + done;
                if (total === 0) return null;
                return (
                  <div key={r.agentId} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate">{r.name}</span>
                      <span className="text-muted-foreground">{total} total</span>
                    </div>
                    <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
                      {done > 0 && <div className="bg-emerald-500" style={{ width: `${(done / total) * 100}%` }} />}
                      {inReview > 0 && <div className="bg-violet-500" style={{ width: `${(inReview / total) * 100}%` }} />}
                      {inProgress > 0 && <div className="bg-blue-500" style={{ width: `${(inProgress / total) * 100}%` }} />}
                      {todo > 0 && <div className="bg-amber-500" style={{ width: `${(todo / total) * 100}%` }} />}
                      {backlog > 0 && <div className="bg-muted-foreground/30" style={{ width: `${(backlog / total) * 100}%` }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground pt-1">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> Done</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-violet-500" /> Review</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-500" /> Active</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-500" /> Todo</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-muted-foreground/30" /> Backlog</span>
            </div>
          </div>
        </div>
      )}

      {/* Performance by Project */}
      {/* Performance by Project */}
      {rows.length > 0 && projects && projects.length > 0 && (() => {
        const activeProjects = projects.filter((p) => !p.archivedAt);
        const effectiveProjectId = selectedProjectId || activeProjects[0]?.id || "";
        const selectedProject = activeProjects.find((p) => p.id === effectiveProjectId);
        const projectIssues = (issues ?? []).filter((i) => i.projectId === effectiveProjectId);

        const projectRows = rows.map((r) => {
          const agentIssues = projectIssues.filter((i) => i.assigneeAgentId === r.agentId);
          const done = agentIssues.filter((i) => i.status === "done").length;
          const active = agentIssues.filter((i) => i.status === "in_progress").length;
          const inReview = agentIssues.filter((i) => i.status === "in_review").length;
          const todo = agentIssues.filter((i) => i.status === "todo").length;
          const backlog = agentIssues.filter((i) => i.status === "backlog").length;
          const blocked = agentIssues.filter((i) => i.status === "blocked").length;
          const total = agentIssues.length;
          let closeMs = 0; let closeCount = 0;
          for (const i of agentIssues.filter((i) => i.status === "done")) {
            if (i.startedAt && i.completedAt) { closeMs += new Date(i.completedAt).getTime() - new Date(i.startedAt).getTime(); closeCount++; }
          }
          const avgCloseH = closeCount > 0 ? closeMs / closeCount / (1000 * 60 * 60) : null;
          const completionRate = (done + agentIssues.filter((i) => i.status === "cancelled").length) > 0
            ? Math.round((done / (done + agentIssues.filter((i) => i.status === "cancelled").length)) * 100)
            : total > 0 ? 0 : null;
          return { ...r, done, active, inReview, todo, backlog, blocked, total, avgCloseH: avgCloseH, completionRate };
        });

        return (
          <div className="rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Performance by Project</h4>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">Project:</span>
              <Select value={effectiveProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {activeProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: p.color ?? "#6366f1" }} />
                        {p.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              </div>
            </div>

            {selectedProject && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: selectedProject.color ?? "#6366f1" }} />
                <span>{projectIssues.length} total issues</span>
                <span>·</span>
                <span>{projectIssues.filter((i) => i.status === "done").length} done</span>
                <span>·</span>
                <span>{projectIssues.filter((i) => i.status === "in_progress").length} active</span>
                {projectIssues.filter((i) => i.status === "blocked").length > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-red-400">{projectIssues.filter((i) => i.status === "blocked").length} blocked</span>
                  </>
                )}
              </div>
            )}

            {/* Mobile card view — project breakdown */}
            <div className="md:hidden divide-y divide-border border-t border-border">
              {projectRows.map((r) => (
                <div key={r.agentId} className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate">{r.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{r.total} total</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm tabular-nums">
                    <div>
                      <div className="text-xs text-muted-foreground/60">Done</div>
                      <div className={r.done > 0 ? "text-emerald-400" : "text-muted-foreground/40"}>{r.done}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground/60">Active</div>
                      <div className={r.active > 0 ? "text-blue-400" : "text-muted-foreground/40"}>{r.active}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground/60">Blocked</div>
                      <div className={r.blocked > 0 ? "text-red-400" : "text-muted-foreground/40"}>{r.blocked}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
                    <div>
                      <div className="text-xs text-muted-foreground/60">Avg time</div>
                      <div className="text-muted-foreground">{r.avgCloseH !== null ? `${r.avgCloseH.toFixed(1)}h` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground/60">Completion</div>
                      <div className="text-muted-foreground">{r.completionRate !== null ? `${r.completionRate}%` : "—"}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Agent</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Done</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Active</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Review</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Todo</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Blocked</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Total</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Avg Time</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Completion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {projectRows.map((r) => (
                    <tr key={r.agentId} className="hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <Identity name={r.name} size="sm" />
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">
                        {r.done > 0 ? <span className="text-emerald-400">{r.done}</span> : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">
                        {r.active > 0 ? <span className="text-blue-400">{r.active}</span> : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">
                        {r.inReview > 0 ? <span className="text-violet-400">{r.inReview}</span> : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">
                        {r.todo > 0 ? <span className="text-amber-400">{r.todo}</span> : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">
                        {r.blocked > 0 ? <span className="text-red-400">{r.blocked}</span> : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums font-medium">
                        {r.total > 0 ? r.total : <span className="text-muted-foreground/40">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {r.avgCloseH !== null ? `${r.avgCloseH.toFixed(1)}h` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.completionRate !== null ? (
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  r.completionRate >= 80 ? "bg-emerald-500" : r.completionRate >= 50 ? "bg-amber-500" : "bg-red-500",
                                )}
                                style={{ width: `${r.completionRate}%` }}
                              />
                            </div>
                            <span className="text-sm text-muted-foreground tabular-nums w-7 text-right">{r.completionRate}%</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

interface Insight {
  type: "warning" | "suggestion" | "positive";
  agent: string;
  agentId: string | null;
  message: string;
  actionLabel: string;
  actionHref: string;
}

function generateInsights(rows: AgentPerfRow[]): Insight[] {
  const insights: Insight[] = [];
  const withTasks = rows.filter((r) => r.tasksDone > 0);
  const avgCost = withTasks.length > 0 ? withTasks.reduce((s, r) => s + (r.costPerTask ?? 0), 0) / withTasks.length : 0;
  const avgClose = withTasks.filter((r) => r.avgCloseH !== null);
  const avgCloseH = avgClose.length > 0 ? avgClose.reduce((s, r) => s + r.avgCloseH!, 0) / avgClose.length : 0;

  // Check if no agents have completed any tasks
  const anyTasksDone = rows.some((r) => r.tasksDone > 0);
  if (!anyTasksDone && rows.length > 0) {
    const spendingAgents = rows.filter((r) => r.totalSpendCents > 0);
    if (spendingAgents.length > 0) {
      insights.push({
        type: "warning",
        agent: "Team",
        agentId: null,
        message: `${spendingAgents.length} agent${spendingAgents.length === 1 ? "" : "s"} have consumed tokens (${formatCents(spendingAgents.reduce((s, r) => s + r.totalSpendCents, 0))} total) but completed 0 tasks. Create and assign issues to start tracking output.`,
        actionLabel: "Create issue",
        actionHref: "/issues",
      });
    }
  }

  for (const row of rows) {
    const agentHref = `/agents/${row.agentId}`;

    // Idle agents — no tasks done and no work in progress
    if (row.tasksDone === 0 && row.tasksInProgress === 0) {
      if (row.totalSpendCents > 0) {
        insights.push({
          type: "warning",
          agent: row.name,
          agentId: row.agentId,
          message: `${row.name} has spent ${formatCents(row.totalSpendCents)} but completed 0 tasks. Spending is from heartbeat runs without assigned work.`,
          actionLabel: "Assign work",
          actionHref: "/issues",
        });
      } else {
        insights.push({
          type: "suggestion",
          agent: row.name,
          agentId: row.agentId,
          message: `${row.name} has no completed or active tasks.`,
          actionLabel: "Configure agent",
          actionHref: agentHref,
        });
      }
      continue;
    }

    // Expensive agents — cost per task > 2x team average
    if (row.costPerTask !== null && avgCost > 0 && row.costPerTask > avgCost * 2) {
      insights.push({
        type: "suggestion",
        agent: row.name,
        agentId: row.agentId,
        message: `${row.name} costs ${formatCents(Math.round(row.costPerTask))}/task (${Math.round(row.costPerTask / avgCost)}x team avg). Switch to a smaller model or reduce context size.`,
        actionLabel: "Edit model config",
        actionHref: agentHref,
      });
    }

    // Slow agents — close time > 2x average
    if (row.avgCloseH !== null && avgCloseH > 0 && row.avgCloseH > avgCloseH * 2) {
      insights.push({
        type: "suggestion",
        agent: row.name,
        agentId: row.agentId,
        message: `${row.name} averages ${row.avgCloseH.toFixed(1)}h per task (${Math.round(row.avgCloseH / avgCloseH)}x team avg). Simplify instructions or break tasks smaller.`,
        actionLabel: "Edit SOUL.md",
        actionHref: agentHref,
      });
    }

    // Low completion rate
    if (row.tasksDone > 2 && row.completionRate < 60) {
      insights.push({
        type: "warning",
        agent: row.name,
        agentId: row.agentId,
        message: `${row.name} has a ${row.completionRate}% completion rate — too many cancelled tasks.`,
        actionLabel: "Review assignments",
        actionHref: `/issues?assignee=${row.agentId}`,
      });
    }

    // Top performers
    if (row.rating === "A" && row.tasksDone >= 3) {
      insights.push({
        type: "positive",
        agent: row.name,
        agentId: row.agentId,
        message: `${row.name} is a top performer — efficient, fast, and reliable.`,
        actionLabel: "Assign high-priority work",
        actionHref: "/issues",
      });
    }
  }

  return insights.sort((a, b) => {
    const order = { warning: 0, suggestion: 1, positive: 2 };
    return order[a.type] - order[b.type];
  });
}

function PerformanceInsights({ rows }: { rows: AgentPerfRow[] }) {
  const insights = useMemo(() => generateInsights(rows), [rows]);

  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Lightbulb className="h-3.5 w-3.5" />
        Performance Insights
      </h4>
      {insights.length === 0 ? (
        <p className="text-sm text-muted-foreground">No insights yet. Insights will appear as agents complete tasks and build up performance history.</p>
      ) : (
      <div className="space-y-2">
        {insights.slice(0, 8).map((insight, i) => (
          <div
            key={`${insight.agent}-${i}`}
            className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-sm"
          >
            {insight.type === "warning" && <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />}
            {insight.type === "suggestion" && <Lightbulb className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />}
            {insight.type === "positive" && <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />}
            <div className="flex-1 min-w-0">
              <span className="text-muted-foreground">{insight.message}</span>
              <span className="mx-1.5 text-border">·</span>
              <Link
                to={insight.actionHref}
                className={cn(
                  "text-xs font-medium underline underline-offset-2 transition-colors",
                  insight.type === "warning" && "text-red-400 hover:text-red-300",
                  insight.type === "suggestion" && "text-amber-400 hover:text-amber-300",
                  insight.type === "positive" && "text-emerald-400 hover:text-emerald-300",
                )}
              >
                {insight.actionLabel} &rarr;
              </Link>
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

/* ── Company KPI Cards ── */

function CompanyKpiCards({ rows }: { rows: AgentPerfRow[] }) {
  const activeRows = rows.filter((r) => r.tasksDone > 0);
  const totalDone = rows.reduce((s, r) => s + r.tasksDone, 0);
  const totalCancelled = rows.reduce(
    (s, r) => s + (r.completionRate > 0 && r.tasksDone > 0 ? Math.round(r.tasksDone * (100 - r.completionRate) / r.completionRate) : 0),
    0,
  );
  const overallSuccessRate = totalDone + totalCancelled > 0
    ? Math.round((totalDone / (totalDone + totalCancelled)) * 100)
    : 0;
  const totalSpend = rows.reduce((s, r) => s + r.totalSpendCents, 0);
  const avgCostPerTask = totalDone > 0 ? totalSpend / totalDone : 0;
  const avgPerfScore = activeRows.length > 0
    ? Math.round(activeRows.reduce((s, r) => s + r.ratingScore, 0) / activeRows.length)
    : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        label="Overall Success Rate"
        value={`${overallSuccessRate}%`}
        color={overallSuccessRate >= 85 ? "text-emerald-400" : overallSuccessRate >= 70 ? "text-amber-400" : "text-red-400"}
      />
      <KpiCard
        label="Avg Cost / Task"
        value={avgCostPerTask > 0 ? formatCents(Math.round(avgCostPerTask)) : "-"}
      />
      <KpiCard
        label="Avg Performance Score"
        value={avgPerfScore > 0 ? String(avgPerfScore) : "-"}
      />
      <KpiCard
        label="Tasks Completed"
        value={String(totalDone)}
        color="text-foreground"
      />
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn("text-2xl font-bold tabular-nums", color)}>{value}</p>
    </div>
  );
}

/* ── Velocity SVG Bar Chart ── */

const VEL_W = 600;
const VEL_H = 160;
const VEL_PAD = { top: 12, right: 16, bottom: 32, left: 40 };
const VEL_INNER_W = VEL_W - VEL_PAD.left - VEL_PAD.right;
const VEL_INNER_H = VEL_H - VEL_PAD.top - VEL_PAD.bottom;

function VelocityChart({ data }: { data: VelocityWeek[] }) {
  const maxVal = Math.max(...data.map((d) => d.issuesCompleted), 1);
  const barCount = data.length;
  const barGap = 4;
  const barW = Math.max(8, (VEL_INNER_W - barGap * (barCount - 1)) / barCount);

  const yTicks = 4;
  const yStep = maxVal / yTicks;

  return (
    <svg
      viewBox={`0 0 ${VEL_W} ${VEL_H}`}
      className="w-full"
      style={{ height: VEL_H }}
      aria-hidden="true"
    >
      {/* Y grid lines */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = yStep * i;
        const y = VEL_PAD.top + VEL_INNER_H - (val / maxVal) * VEL_INNER_H;
        return (
          <g key={i}>
            <line
              x1={VEL_PAD.left}
              y1={y}
              x2={VEL_W - VEL_PAD.right}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={VEL_PAD.left - 4}
              y={y + 4}
              textAnchor="end"
              fontSize={10}
              className="fill-muted-foreground"
              fontFamily="var(--font-sans)"
            >
              {Math.round(val)}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const x = VEL_PAD.left + i * (barW + barGap);
        const barH = maxVal > 0 ? (d.issuesCompleted / maxVal) * VEL_INNER_H : 0;
        const y = VEL_PAD.top + VEL_INNER_H - barH;
        const labelDate = new Date(d.weekStart + "T12:00:00");
        const label = `${labelDate.getMonth() + 1}/${labelDate.getDate()}`;

        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={barH}
              fill="#3b82f6"
              fillOpacity={0.75}
              rx={2}
            />
            {(i === 0 || i === barCount - 1 || i % 2 === 0) && (
              <text
                x={x + barW / 2}
                y={VEL_H - 4}
                textAnchor="middle"
                fontSize={10}
                className="fill-muted-foreground"
                fontFamily="var(--font-sans)"
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function SortHeader({
  field,
  label,
  current,
  dir,
  onToggle,
  align = "right",
  className,
}: {
  field: SortField;
  label: string;
  current: SortField;
  dir: "asc" | "desc";
  onToggle: (field: SortField) => void;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  return (
    <th className={cn("px-4 py-3", align === "center" ? "text-center" : align === "left" ? "text-left" : "text-right", className)}>
      <button
        className={cn(
          "text-xs font-medium uppercase tracking-wider transition-colors",
          current === field ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => onToggle(field)}
      >
        {label}
        {current === field && (
          <span className="ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>
        )}
      </button>
    </th>
  );
}
