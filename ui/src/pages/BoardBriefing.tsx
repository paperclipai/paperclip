import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { costsApi } from "../api/costs";
import { goalProgressApi } from "../api/goalProgress";
import { hiringApi } from "../api/hiring";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { computeAgentPerformance } from "./AgentPerformance";
import {
  FileText,
  Users,
  DollarSign,
  Target,
  ClipboardList,
  BarChart3,
  History,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
} from "lucide-react";
import type { Agent } from "@ironworksai/shared";

export function BoardBriefing() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Board Briefing" }]);
  }, [setBreadcrumbs]);

  // -- Data fetching --
  const { data: headcount, isLoading: headcountLoading } = useQuery({
    queryKey: queryKeys.headcount(selectedCompanyId!),
    queryFn: () => agentsApi.headcount(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: windowSpend } = useQuery({
    queryKey: queryKeys.usageWindowSpend(selectedCompanyId!),
    queryFn: () => costsApi.windowSpend(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: goalsProgress } = useQuery({
    queryKey: ["goals", "progress", selectedCompanyId!],
    queryFn: () => goalProgressApi.batch(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: hiringRequests } = useQuery({
    queryKey: queryKeys.hiring.list(selectedCompanyId!),
    queryFn: () => hiringApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: agents } = useQuery({
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

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // -- Derived data --

  const weekSpendCents = useMemo(() => {
    if (!windowSpend) return 0;
    return windowSpend
      .filter((r) => r.window === "7d")
      .reduce((sum, r) => sum + r.costCents, 0);
  }, [windowSpend]);

  // Rough "last week" calculation: we don't have the exact prior-7d bucket,
  // so estimate using 30d minus current 7d (a rough proxy).
  const monthSpendCents = useMemo(() => {
    if (!windowSpend) return 0;
    return windowSpend
      .filter((r) => r.window === "30d")
      .reduce((sum, r) => sum + r.costCents, 0);
  }, [windowSpend]);

  const lastWeekEstimate = useMemo(() => {
    // approximate: (30d - 7d) / 3 to get weekly average of remaining 3 weeks
    if (monthSpendCents <= weekSpendCents) return 0;
    return Math.round((monthSpendCents - weekSpendCents) / 3);
  }, [monthSpendCents, weekSpendCents]);

  const spendTrend = weekSpendCents - lastWeekEstimate;
  const monthlyProjection = Math.round(weekSpendCents * 4.33);

  // Goals
  const goalStats = useMemo(() => {
    const goals = goalsProgress ?? [];
    const total = goals.length;
    const completed = goals.filter((g) => g.progressPercent === 100).length;
    const inProgress = goals.filter((g) => g.progressPercent > 0 && g.progressPercent < 100).length;
    const atRisk = goals.filter((g) => g.blockedIssues > 0).length;
    return { total, completed, inProgress, atRisk };
  }, [goalsProgress]);

  // Hiring
  const pendingHiring = useMemo(
    () => (hiringRequests ?? []).filter((h) => h.status === "pending" || h.status === "pending_approval"),
    [hiringRequests],
  );

  const pendingApprovals = approvals ?? [];

  // Agent performance
  const perfRows = useMemo(
    () => computeAgentPerformance(agents ?? [], issues ?? [], costsByAgent ?? [], "30d"),
    [agents, issues, costsByAgent],
  );

  const topPerformers = perfRows.filter((r) => r.tasksDone > 0).slice(0, 3);
  const bottomPerformers = perfRows
    .filter((r) => r.tasksDone > 0)
    .slice(-3)
    .reverse();

  // Agent map for activity
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    return map;
  }, [issues, agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const recentActivity = useMemo(
    () => (activity ?? []).slice(0, 10),
    [activity],
  );

  // Date string
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view the board briefing." />;
  }

  if (headcountLoading) return <PageSkeleton variant="dashboard" />;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Board Briefing</h1>
        <p className="text-sm text-muted-foreground mt-1">{dateStr}</p>
        <p className="text-sm text-muted-foreground">
          Generated for <span className="font-medium text-foreground">{selectedCompany?.name ?? "Company"}</span>
        </p>
      </div>

      {/* 1. Headcount + 2. Cost Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Headcount Card */}
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            Headcount
          </h3>
          {headcount ? (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold tabular-nums">{headcount.fte + headcount.contractor}</span>
                <span className="text-sm text-muted-foreground">total agents</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground tabular-nums">
                <div className="flex justify-between">
                  <span>Full-time</span>
                  <span className="font-medium text-foreground">{headcount.fte}</span>
                </div>
                <div className="flex justify-between">
                  <span>Contractors</span>
                  <span className="font-medium text-foreground">{headcount.contractor}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No headcount data.</p>
          )}
        </div>

        {/* Cost Summary Card */}
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-3.5 w-3.5" />
            Cost Summary
          </h3>
          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tabular-nums">{formatCents(weekSpendCents)}</span>
              <span className="text-sm text-muted-foreground">this week</span>
            </div>
            <div className="space-y-1.5 text-sm text-muted-foreground tabular-nums">
              <div className="flex justify-between">
                <span>Last week (est.)</span>
                <span>{formatCents(lastWeekEstimate)}</span>
              </div>
              <div className="flex justify-between">
                <span>Trend</span>
                <span className={cn(
                  "flex items-center gap-1",
                  spendTrend > 0 ? "text-amber-400" : "text-emerald-400",
                )}>
                  {spendTrend > 0 ? (
                    <TrendingUp className="h-3.5 w-3.5" />
                  ) : (
                    <TrendingDown className="h-3.5 w-3.5" />
                  )}
                  {spendTrend > 0 ? "+" : ""}{formatCents(Math.abs(spendTrend))}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Monthly projection</span>
                <span className="font-medium text-foreground">{formatCents(monthlyProjection)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Goal Progress + 4. Pending Decisions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Goal Progress Card */}
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Target className="h-3.5 w-3.5" />
            Goal Progress
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <StatBlock label="Total Goals" value={goalStats.total} />
            <StatBlock label="Completed" value={goalStats.completed} color="text-emerald-400" />
            <StatBlock label="In Progress" value={goalStats.inProgress} color="text-blue-400" />
            <StatBlock label="At Risk" value={goalStats.atRisk} color={goalStats.atRisk > 0 ? "text-red-400" : undefined} />
          </div>
        </div>

        {/* Pending Decisions Card */}
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <ClipboardList className="h-3.5 w-3.5" />
            Pending Decisions
          </h3>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Open hiring requests</span>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{pendingHiring.length}</span>
                {pendingHiring.length > 0 && (
                  <Link to="/agents" className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2">
                    Review
                  </Link>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Pending approvals</span>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{pendingApprovals.length}</span>
                {pendingApprovals.length > 0 && (
                  <Link to="/approvals/pending" className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2">
                    Review
                  </Link>
                )}
              </div>
            </div>
            {pendingHiring.length === 0 && pendingApprovals.length === 0 && (
              <p className="text-sm text-muted-foreground/60 pt-1">No pending decisions. All clear.</p>
            )}
          </div>
        </div>
      </div>

      {/* 5. Agent Performance Summary */}
      <div className="rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5" />
            Agent Performance Summary
          </h3>
          <Link to="/performance" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Full report
          </Link>
        </div>

        {perfRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent performance data yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top 3 */}
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-emerald-400 uppercase tracking-wider">Top Performers</h4>
              {topPerformers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {topPerformers.map((r) => (
                    <AgentPerfSummaryRow key={r.agentId} row={r} />
                  ))}
                </div>
              )}
            </div>

            {/* Bottom 3 */}
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                Concerns
              </h4>
              {bottomPerformers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {bottomPerformers.map((r) => (
                    <AgentPerfSummaryRow key={r.agentId} row={r} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 6. Recent Activity */}
      {recentActivity.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <History className="h-3.5 w-3.5" />
              Recent Activity
            </h3>
            <Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              View all
            </Link>
          </div>
          <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
            {recentActivity.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBlock({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/30 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-bold tabular-nums", color)}>{value}</p>
    </div>
  );
}

const RATING_COLORS: Record<string, string> = {
  A: "text-emerald-400 bg-emerald-500/10",
  B: "text-blue-400 bg-blue-500/10",
  C: "text-amber-400 bg-amber-500/10",
  D: "text-orange-400 bg-orange-500/10",
  F: "text-red-400 bg-red-500/10",
};

function AgentPerfSummaryRow({ row }: { row: { agentId: string; name: string; rating: string; ratingScore: number; tasksDone: number; completionRate: number } }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <span className={cn(
        "inline-flex items-center justify-center h-6 w-6 rounded text-xs font-bold shrink-0",
        RATING_COLORS[row.rating] ?? "text-muted-foreground bg-muted",
      )}>
        {row.rating}
      </span>
      <span className="truncate flex-1 font-medium">{row.name}</span>
      <span className="text-muted-foreground tabular-nums shrink-0 text-xs">
        {row.tasksDone} tasks - {row.completionRate}%
      </span>
    </div>
  );
}
