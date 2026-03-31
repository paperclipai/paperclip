import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, cn, agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
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
  const { setBreadcrumbs } = useBreadcrumbs();
  const [range, setRange] = useState<TimeRange>("30d");
  const [sortField, setSortField] = useState<SortField>("rating");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  const rows = useMemo(
    () => computeAgentPerformance(agents ?? [], issues ?? [], costsByAgent ?? [], range),
    [agents, issues, costsByAgent, range],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
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
        <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden">
          {(["7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              className={cn(
                "px-3 py-1.5 text-xs transition-colors",
                range === r ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setRange(r)}
            >
              {r === "all" ? "All time" : r === "7d" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>

      {/* Team summary */}
      <div className="flex items-center gap-4 rounded-xl border border-border p-4">
        <div className={cn("inline-flex items-center justify-center h-12 w-12 rounded-xl border text-xl font-bold", RATING_COLORS[teamRating])}>
          {teamRating}
        </div>
        <div>
          <p className="text-sm font-medium">Team Average</p>
          <p className="text-xs text-muted-foreground">
            {rows.filter((r) => r.tasksDone > 0).length} active agents · {rows.reduce((s, r) => s + r.tasksDone, 0)} tasks completed · {formatCents(rows.reduce((s, r) => s + r.totalSpendCents, 0))} total spend
          </p>
        </div>
      </div>

      {/* Insights */}
      {rows.length > 0 && <PerformanceInsights rows={rows} />}

      {/* Table */}
      {sorted.length === 0 ? (
        <EmptyState icon={BarChart3} message="No agents to evaluate." />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Agent</th>
                  <SortHeader field="rating" label="Rating" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="tasksDone" label="Done" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="throughput" label="Tasks/Day" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="avgCloseH" label="Avg Time" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="costPerTask" label="$/Task" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="totalSpendCents" label="Total Spend" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader field="completionRate" label="Completion" current={sortField} dir={sortDir} onToggle={toggleSort} />
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
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center justify-center h-7 w-7 rounded-lg border text-xs font-bold", RATING_COLORS[row.rating])}>
                        {row.rating}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
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
                        <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{row.completionRate}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface Insight {
  type: "warning" | "suggestion" | "positive";
  agent: string;
  message: string;
}

function generateInsights(rows: AgentPerfRow[]): Insight[] {
  const insights: Insight[] = [];
  const withTasks = rows.filter((r) => r.tasksDone > 0);
  const avgCost = withTasks.length > 0 ? withTasks.reduce((s, r) => s + (r.costPerTask ?? 0), 0) / withTasks.length : 0;
  const avgClose = withTasks.filter((r) => r.avgCloseH !== null);
  const avgCloseH = avgClose.length > 0 ? avgClose.reduce((s, r) => s + r.avgCloseH!, 0) / avgClose.length : 0;

  for (const row of rows) {
    // Idle agents — no tasks done
    if (row.tasksDone === 0 && row.tasksInProgress === 0 && row.status === "active") {
      insights.push({
        type: "warning",
        agent: row.name,
        message: `${row.name} has no completed or active tasks. Consider assigning work or reviewing their role configuration.`,
      });
      continue;
    }

    // Expensive agents — cost per task > 2x team average
    if (row.costPerTask !== null && avgCost > 0 && row.costPerTask > avgCost * 2) {
      insights.push({
        type: "suggestion",
        agent: row.name,
        message: `${row.name} costs ${formatCents(Math.round(row.costPerTask))}/task (${Math.round(row.costPerTask / avgCost)}x team avg). Try switching to a smaller model, reducing context size, or breaking tasks into smaller units.`,
      });
    }

    // Slow agents — close time > 2x average
    if (row.avgCloseH !== null && avgCloseH > 0 && row.avgCloseH > avgCloseH * 2) {
      insights.push({
        type: "suggestion",
        agent: row.name,
        message: `${row.name} averages ${row.avgCloseH.toFixed(1)}h per task (${Math.round(row.avgCloseH / avgCloseH)}x team avg). Review their SOUL.md for overly broad instructions, or simplify assigned tasks.`,
      });
    }

    // Low completion rate
    if (row.tasksDone > 2 && row.completionRate < 60) {
      insights.push({
        type: "warning",
        agent: row.name,
        message: `${row.name} has a ${row.completionRate}% completion rate. Many tasks are being cancelled. Review task assignments for role fit.`,
      });
    }

    // Top performers
    if (row.rating === "A" && row.tasksDone >= 3) {
      insights.push({
        type: "positive",
        agent: row.name,
        message: `${row.name} is a top performer — efficient, fast, and reliable. Consider assigning higher-priority work.`,
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
  if (insights.length === 0) return null;

  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Lightbulb className="h-3.5 w-3.5" />
        Performance Insights
      </h4>
      <div className="space-y-2">
        {insights.slice(0, 6).map((insight, i) => (
          <div
            key={`${insight.agent}-${i}`}
            className={cn(
              "flex items-start gap-2.5 rounded-lg px-3 py-2 text-sm",
              insight.type === "warning" && "bg-red-500/[0.04] border border-red-500/15",
              insight.type === "suggestion" && "bg-amber-500/[0.04] border border-amber-500/15",
              insight.type === "positive" && "bg-emerald-500/[0.04] border border-emerald-500/15",
            )}
          >
            {insight.type === "warning" && <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />}
            {insight.type === "suggestion" && <TrendingDown className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />}
            {insight.type === "positive" && <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />}
            <span className="text-muted-foreground">{insight.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SortHeader({
  field,
  label,
  current,
  dir,
  onToggle,
}: {
  field: SortField;
  label: string;
  current: SortField;
  dir: "asc" | "desc";
  onToggle: (field: SortField) => void;
}) {
  return (
    <th className="px-4 py-3 text-right">
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
