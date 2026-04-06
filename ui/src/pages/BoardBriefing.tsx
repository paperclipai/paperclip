import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { channelsApi } from "../api/channels";
import { issuesApi } from "../api/issues";
import { costsApi } from "../api/costs";
import { goalsApi } from "../api/goals";
import { goalProgressApi } from "../api/goalProgress";
import { hiringApi } from "../api/hiring";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import { executiveApi } from "../api/executive";
import type { DORAMetrics, RiskItem, PermissionMatrixData, DepartmentImpactRow, HumanOverrideRate } from "../api/executive";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { CapacityPlanning } from "../components/CapacityPlanning";
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
  Shield,
  Clock,
  Wrench,
  Activity,
  Lock,
  Check,
  Cpu,
  Building2,
  UserCheck,
  Megaphone,
  LineChart,
  Brain,
  Printer,
  Download,
} from "lucide-react";
import type { Agent } from "@ironworksai/shared";

type BriefingPeriod = "7d" | "30d" | "this_month";
const PERIOD_LABELS: Record<BriefingPeriod, string> = {
  "7d": "This Week",
  "30d": "Last 30 Days",
  "this_month": "This Month",
};

export function BoardBriefing() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [period, setPeriod] = useState<BriefingPeriod>("30d");

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

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
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

  const { data: slaData } = useQuery({
    queryKey: ["executive", "sla", selectedCompanyId!],
    queryFn: () => executiveApi.slaCompliance(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: techDebtData } = useQuery({
    queryKey: ["executive", "tech-debt", selectedCompanyId!],
    queryFn: () => executiveApi.techDebt(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: riskData } = useQuery({
    queryKey: ["executive", "risk-register", selectedCompanyId!],
    queryFn: () => executiveApi.riskRegister(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: healthScore } = useQuery({
    queryKey: ["executive", "health-score", selectedCompanyId!],
    queryFn: () => executiveApi.healthScore(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: permissionMatrix } = useQuery({
    queryKey: ["executive", "permission-matrix", selectedCompanyId!],
    queryFn: () => executiveApi.permissionMatrix(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: doraMetrics } = useQuery({
    queryKey: ["executive", "dora-metrics", selectedCompanyId!],
    queryFn: () => executiveApi.doraMetrics(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: departmentImpactData } = useQuery({
    queryKey: ["executive", "department-impact", selectedCompanyId!],
    queryFn: () => executiveApi.departmentImpact(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: humanOverrideData } = useQuery({
    queryKey: ["executive", "human-override-rate", selectedCompanyId!],
    queryFn: () => executiveApi.humanOverrideRate(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const { data: expertiseMap } = useQuery({
    queryKey: queryKeys.channels.expertiseMap(selectedCompanyId!),
    queryFn: () => channelsApi.expertiseMap(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 120_000,
  });

  // Weekly trend data: 8 weeks of cost + issues via windowSpend and issues list
  // Both are already fetched above; we compute trends from existing data.

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

  // Goals - enhanced with health status
  const goalStats = useMemo(() => {
    const progressList = goalsProgress ?? [];
    const goalsList = allGoals ?? [];
    const total = progressList.length;
    const completed = progressList.filter((g) => g.progressPercent === 100).length;
    const inProgress = progressList.filter((g) => g.progressPercent > 0 && g.progressPercent < 100).length;
    const atRisk = progressList.filter((g) => g.blockedIssues > 0).length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Health status counts from actual goal objects
    let onTrack = 0;
    let healthAtRisk = 0;
    let offTrack = 0;
    const topAtRisk: Array<{ id: string; title: string; healthScore: number | null; healthStatus: string | null; ownerAgentId: string | null }> = [];

    for (const g of goalsList) {
      if (g.healthStatus === "on_track") onTrack++;
      else if (g.healthStatus === "at_risk") {
        healthAtRisk++;
        topAtRisk.push(g);
      } else if (g.healthStatus === "off_track") {
        offTrack++;
        topAtRisk.push(g);
      }
    }

    // Sort at-risk goals by health score ascending (worst first)
    topAtRisk.sort((a, b) => (a.healthScore ?? 0) - (b.healthScore ?? 0));

    return {
      total,
      completed,
      inProgress,
      atRisk,
      completionRate,
      onTrack,
      healthAtRisk,
      offTrack,
      topAtRisk: topAtRisk.slice(0, 5),
    };
  }, [goalsProgress, allGoals]);

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

  // CMO / marketing department data derived from departmentImpact
  const marketingDept = useMemo(
    () => (departmentImpactData ?? []).find(
      (d) => d.department.toLowerCase().includes("market") || d.department.toLowerCase().includes("cmo"),
    ),
    [departmentImpactData],
  );

  // Weekly trend buckets derived from issues list (simple 8-week retrospective)
  const issueTrendWeeks = useMemo(() => {
    const now = Date.now();
    const weeks: Array<{ label: string; count: number }> = [];
    for (let i = 7; i >= 0; i--) {
      const weekStart = now - (i + 1) * 7 * 24 * 60 * 60 * 1000;
      const weekEnd = now - i * 7 * 24 * 60 * 60 * 1000;
      const label = new Date(weekEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const count = (issues ?? []).filter((iss) => {
        if (iss.status !== "done" || !iss.completedAt) return false;
        const t = new Date(iss.completedAt).getTime();
        return t >= weekStart && t < weekEnd;
      }).length;
      weeks.push({ label, count });
    }
    return weeks;
  }, [issues]);

  const spendTrendWeeks = useMemo(() => {
    // Use windowSpend 30d vs 7d to approximate; we can only produce two data points here
    // without a dedicated trend API. Spread them across 8 buckets with the data we have.
    // The first 7 buckets estimate prior weekly average from the 30d window,
    // and the last bucket is the current 7d window.
    const priorMonthly = monthSpendCents - weekSpendCents;
    const priorWeeklyAvg = priorMonthly > 0 ? Math.round(priorMonthly / 3) : 0;
    const weeks: Array<{ label: string; cost: number }> = [];
    const now = Date.now();
    for (let i = 7; i >= 1; i--) {
      const weekEnd = now - i * 7 * 24 * 60 * 60 * 1000;
      const label = new Date(weekEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      weeks.push({ label, cost: priorWeeklyAvg });
    }
    weeks.push({
      label: "This week",
      cost: weekSpendCents,
    });
    return weeks;
  }, [weekSpendCents, monthSpendCents]);

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
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Board Briefing</h1>
            <p className="text-sm text-muted-foreground mt-1">{dateStr}</p>
            <p className="text-sm text-muted-foreground">
              Generated for <span className="font-medium text-foreground">{selectedCompany?.name ?? "Company"}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors print:hidden"
              onClick={() => window.print()}
              aria-label="Print briefing"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 transition-colors print:hidden"
              onClick={() => {
                // Trigger browser print dialog which allows "Save as PDF"
                const style = document.createElement("style");
                style.textContent = "@media print { @page { size: A4; margin: 1cm; } }";
                document.head.appendChild(style);
                window.print();
                setTimeout(() => document.head.removeChild(style), 1000);
              }}
              aria-label="Export as PDF"
            >
              <Download className="h-3.5 w-3.5" />
              Export PDF
            </button>
            <div
              className="flex items-center gap-1 border border-border rounded-md overflow-hidden shrink-0 print:hidden"
              role="group"
              aria-label="Briefing period"
            >
              {(["7d", "30d", "this_month"] as const).map((p) => (
                <button
                  key={p}
                  className={cn(
                    "px-3 py-1.5 text-xs transition-colors",
                    period === p ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Executive Summary */}
      <div className="rounded-xl border border-border p-5 bg-muted/10">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Executive Summary</h3>
        <p className="text-sm text-foreground leading-relaxed">
          {selectedCompany?.name ?? "The company"} currently operates with{" "}
          <Link to="/org" className="text-blue-400 hover:underline font-medium">{headcount ? headcount.fte + headcount.contractor : 0} agents</Link>{" "}
          ({headcount?.fte ?? 0} full-time, {headcount?.contractor ?? 0} contractors).
          {" "}Over the selected period, the team completed{" "}
          <Link to="/issues" className="text-blue-400 hover:underline font-medium">{perfRows.reduce((s, r) => s + r.tasksDone, 0)} tasks</Link>{" "}
          at a total cost of{" "}
          <Link to="/costs" className="text-blue-400 hover:underline font-medium">{formatCents(weekSpendCents)}</Link> this week
          ({spendTrend > 0 ? "up" : "down"} {formatCents(Math.abs(spendTrend))} from last week).
          {goalStats.atRisk > 0 && ` There ${goalStats.atRisk === 1 ? "is" : "are"} ${goalStats.atRisk} goal${goalStats.atRisk === 1 ? "" : "s"} at risk requiring attention.`}
          {pendingHiring.length > 0 && ` ${pendingHiring.length} hiring request${pendingHiring.length === 1 ? " is" : "s are"} pending review.`}
          {pendingApprovals.length > 0 && ` ${pendingApprovals.length} approval${pendingApprovals.length === 1 ? " awaits" : "s await"} decision.`}
        </p>
      </div>

      {/* 0. Company Health Score */}
      {healthScore && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Activity className="h-3.5 w-3.5" />
            Company Health Score
          </h3>
          <div className="flex items-center gap-6">
            <div className="flex flex-col items-center">
              <span className={cn(
                "text-5xl font-bold tabular-nums",
                healthScore.score >= 80 ? "text-emerald-400" :
                healthScore.score >= 60 ? "text-blue-400" :
                healthScore.score >= 40 ? "text-amber-400" : "text-red-400",
              )}>
                {healthScore.score}
              </span>
              <span className="text-xs text-muted-foreground mt-1">out of 100</span>
            </div>
            <div className="flex-1 grid grid-cols-2 sm:grid-cols-5 gap-3">
              <HealthBreakdownItem label="Agents" value={healthScore.breakdown.agentPerformance} />
              <HealthBreakdownItem label="Goals" value={healthScore.breakdown.goalCompletion} />
              <HealthBreakdownItem label="Budget" value={healthScore.breakdown.budgetHealth} />
              <HealthBreakdownItem label="SLA" value={healthScore.breakdown.slaCompliance} />
              <HealthBreakdownItem label="Risk" value={healthScore.breakdown.riskLevel} />
            </div>
          </div>
        </div>
      )}

      {/* 1. Headcount + 2. Cost Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Headcount Card - drill-down to Org Chart */}
        <Link to="/org" className="no-underline text-inherit block">
        <div className="rounded-xl border border-border p-5 space-y-3 hover:border-foreground/20 transition-colors cursor-pointer">
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
        </Link>

        {/* Cost Summary Card - drill-down to Costs page */}
        <Link to="/costs" className="no-underline text-inherit block">
        <div className="rounded-xl border border-border p-5 space-y-3 hover:border-foreground/20 transition-colors cursor-pointer">
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
        </Link>
      </div>

      {/* 3. Goal Progress + 4. Pending Decisions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Goal Health Card - drill-down to Goals */}
        <Link to="/goals" className="no-underline text-inherit block">
        <div className="rounded-xl border border-border p-5 space-y-3 hover:border-foreground/20 transition-colors cursor-pointer">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Target className="h-3.5 w-3.5" />
            Goal Health
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <StatBlock label="Total Goals" value={goalStats.total} />
            <StatBlock label="Completion Rate" value={`${goalStats.completionRate}%`} color="text-blue-400" />
            <StatBlock label="On Track" value={goalStats.onTrack} color="text-emerald-400" />
            <StatBlock label="At Risk" value={goalStats.healthAtRisk} color={goalStats.healthAtRisk > 0 ? "text-amber-400" : undefined} />
            <StatBlock label="Off Track" value={goalStats.offTrack} color={goalStats.offTrack > 0 ? "text-red-400" : undefined} />
            <StatBlock label="Completed" value={goalStats.completed} color="text-emerald-400" />
          </div>
          {goalStats.topAtRisk.length > 0 && (
            <div className="pt-2 border-t border-border space-y-1.5">
              <span className="text-[10px] text-muted-foreground font-medium uppercase">Top at-risk goals</span>
              {goalStats.topAtRisk.map((g) => (
                <div key={g.id} className="flex items-center gap-2 text-xs">
                  <span className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    g.healthStatus === "off_track" ? "bg-red-500" : "bg-amber-500",
                  )} />
                  <span className="truncate flex-1">{g.title}</span>
                  {g.healthScore != null && (
                    <span className="text-muted-foreground tabular-nums shrink-0">{g.healthScore}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        </Link>

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

      {/* 6. SLA Compliance + Tech Debt */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Clock className="h-3.5 w-3.5" />
            SLA Compliance
          </h3>
          {slaData ? (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  "text-3xl font-bold tabular-nums",
                  slaData.compliancePercent >= 90 ? "text-emerald-400" :
                  slaData.compliancePercent >= 70 ? "text-amber-400" : "text-red-400",
                )}>
                  {slaData.compliancePercent}%
                </span>
                <span className="text-sm text-muted-foreground">compliance</span>
              </div>
              <div className="text-sm text-muted-foreground">
                {slaData.withinSla} of {slaData.total} issues resolved within SLA
              </div>
              {slaData.byPriority.length > 0 && (
                <div className="space-y-1 pt-1 border-t border-border/50">
                  {slaData.byPriority.map((p: { priority: string; compliancePercent: number; met: number; total: number }) => (
                    <div key={p.priority} className="flex justify-between text-xs">
                      <span className="capitalize text-muted-foreground">{p.priority}</span>
                      <span className={cn(
                        "tabular-nums font-medium",
                        p.compliancePercent >= 90 ? "text-emerald-400" :
                        p.compliancePercent >= 70 ? "text-amber-400" : "text-red-400",
                      )}>
                        {p.compliancePercent}% ({p.met}/{p.total})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading SLA data...</p>
          )}
        </div>

        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5" />
            Tech Debt
          </h3>
          {techDebtData ? (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  "text-3xl font-bold tabular-nums",
                  techDebtData.openCount > 10 ? "text-red-400" :
                  techDebtData.openCount > 5 ? "text-amber-400" : "text-foreground",
                )}>
                  {techDebtData.openCount}
                </span>
                <span className="text-sm text-muted-foreground">open items</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground tabular-nums">
                <div className="flex justify-between">
                  <span>Last 30d</span>
                  <span className="font-medium text-foreground">{techDebtData.createdLast30d}</span>
                </div>
                <div className="flex justify-between">
                  <span>Trend</span>
                  <span className={cn(
                    "flex items-center gap-1 font-medium",
                    techDebtData.trend > 0 ? "text-amber-400" : techDebtData.trend < 0 ? "text-emerald-400" : "text-foreground",
                  )}>
                    {techDebtData.trend > 0 ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : techDebtData.trend < 0 ? (
                      <TrendingDown className="h-3 w-3" />
                    ) : null}
                    {techDebtData.trend > 0 ? "+" : ""}{techDebtData.trend}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading tech debt data...</p>
          )}
        </div>
      </div>

      {/* 7. Risk Summary */}
      {riskData && riskData.totalRisks > 0 && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Shield className="h-3.5 w-3.5" />
            Risk Summary
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatBlock
              label="Critical"
              value={riskData.countByLevel.critical ?? 0}
              color={riskData.countByLevel.critical > 0 ? "text-red-400" : undefined}
            />
            <StatBlock
              label="High"
              value={riskData.countByLevel.high ?? 0}
              color={riskData.countByLevel.high > 0 ? "text-orange-400" : undefined}
            />
            <StatBlock
              label="Medium"
              value={riskData.countByLevel.medium ?? 0}
              color={riskData.countByLevel.medium > 0 ? "text-amber-400" : undefined}
            />
            <StatBlock
              label="Low"
              value={riskData.countByLevel.low ?? 0}
            />
          </div>
          {riskData.risks.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-border/50">
              {riskData.risks.slice(0, 5).map((risk: RiskItem, i: number) => (
                <div key={`${risk.entityId}-${i}`} className="flex items-start gap-2.5 text-sm">
                  <span className={cn(
                    "inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold shrink-0 mt-0.5",
                    risk.level === "critical" ? "text-red-400 bg-red-500/10" :
                    risk.level === "high" ? "text-orange-400 bg-orange-500/10" :
                    risk.level === "medium" ? "text-amber-400 bg-amber-500/10" :
                    "text-muted-foreground bg-muted",
                  )}>
                    {risk.level[0].toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{risk.title}</div>
                    <div className="text-xs text-muted-foreground">{risk.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 8. Permission Matrix */}
      {permissionMatrix && permissionMatrix.agents.length > 0 && permissionMatrix.permissions.length > 0 && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Lock className="h-3.5 w-3.5" />
            Agent Permission Matrix
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-semibold text-muted-foreground sticky left-0 bg-background">
                    Agent
                  </th>
                  {permissionMatrix.permissions.map((perm) => (
                    <th
                      key={perm}
                      className="px-2 py-2 text-center font-medium text-muted-foreground whitespace-nowrap"
                      title={perm}
                    >
                      {perm.split(":").pop()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {permissionMatrix.agents.map((agent) => (
                  <tr key={agent.agentId} className="border-b border-border/50 hover:bg-accent/10">
                    <td className="px-2 py-1.5 font-medium sticky left-0 bg-background whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>{agent.name}</span>
                        {agent.department && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {agent.department}
                          </span>
                        )}
                      </div>
                    </td>
                    {permissionMatrix.permissions.map((perm) => (
                      <td key={perm} className="px-2 py-1.5 text-center">
                        {agent.permissions[perm] ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400 mx-auto" />
                        ) : (
                          <span className="text-muted-foreground/20">-</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 9. Engineering Metrics (DORA) */}
      {doraMetrics && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5" />
            Engineering Metrics
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <DORAMetricBlock
              label="Deployment Frequency"
              value={`${doraMetrics.deploymentFrequency.toFixed(1)}/day`}
              tier={doraMetrics.deploymentFrequency >= 1 ? "elite" : doraMetrics.deploymentFrequency >= 0.14 ? "high" : doraMetrics.deploymentFrequency >= 0.03 ? "medium" : "low"}
              description="Heartbeat runs per day (proxy)"
            />
            <DORAMetricBlock
              label="Lead Time"
              value={doraMetrics.leadTime < 60 ? `${doraMetrics.leadTime}m` : `${Math.round(doraMetrics.leadTime / 60)}h`}
              tier={doraMetrics.leadTime <= 60 ? "elite" : doraMetrics.leadTime <= 1440 ? "high" : doraMetrics.leadTime <= 10080 ? "medium" : "low"}
              description="Avg issue created to done"
            />
            <DORAMetricBlock
              label="Change Failure Rate"
              value={`${doraMetrics.changeFailureRate.toFixed(1)}%`}
              tier={doraMetrics.changeFailureRate <= 5 ? "elite" : doraMetrics.changeFailureRate <= 10 ? "high" : doraMetrics.changeFailureRate <= 15 ? "medium" : "low"}
              description="Cancelled / total issues"
            />
            <DORAMetricBlock
              label="Mean Time to Recovery"
              value={doraMetrics.meanTimeToRecovery < 60 ? `${doraMetrics.meanTimeToRecovery}m` : `${Math.round(doraMetrics.meanTimeToRecovery / 60)}h`}
              tier={doraMetrics.meanTimeToRecovery <= 60 ? "elite" : doraMetrics.meanTimeToRecovery <= 1440 ? "high" : doraMetrics.meanTimeToRecovery <= 10080 ? "medium" : "low"}
              description="Critical/high issue resolution time"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            DORA tiers: green = Elite, blue = High, amber = Medium, red = Low. Based on last 30 days.
          </p>
        </div>
      )}

      {/* 10. Human Override Rate KPI */}
      {humanOverrideData && (
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <UserCheck className="h-3.5 w-3.5" />
            Human Override Rate
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <StatBlock label="Total Runs" value={humanOverrideData.totalRuns} />
            <StatBlock
              label="Overrides"
              value={humanOverrideData.overriddenRuns}
              color={humanOverrideData.overriddenRuns > 0 ? "text-amber-400" : undefined}
            />
            <div className="rounded-lg bg-muted/30 px-3 py-2.5">
              <p className="text-xs text-muted-foreground">Override Rate</p>
              <p className={cn(
                "text-2xl font-bold tabular-nums",
                humanOverrideData.overrideRate > 20 ? "text-red-400" :
                humanOverrideData.overrideRate > 10 ? "text-amber-400" : "text-emerald-400",
              )}>
                {humanOverrideData.overrideRate}%
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Percentage of agent runs that required a human approval or override. Lower is better. Last 30 days.
          </p>
        </div>
      )}

      {/* 11. Department Impact Breakdown */}
      {departmentImpactData && departmentImpactData.length > 0 && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Building2 className="h-3.5 w-3.5" />
            Department Impact
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground">Department</th>
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground text-right">Issues Done</th>
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground text-right">Total Cost</th>
                  <th className="pb-2 font-semibold text-muted-foreground text-right">Human-Hrs Equiv.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {(departmentImpactData as DepartmentImpactRow[]).map((row) => (
                  <tr key={row.department} className="text-sm">
                    <td className="py-1.5 pr-4 font-medium">{row.department}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.issuesCompleted}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-muted-foreground">
                      {formatCents(row.totalCost)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {row.humanHoursEquivalent}h
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Human-hours equivalent assumes 2 hours per completed issue. Last 30 days.
          </p>
        </div>
      )}

      {/* 12. CMO Campaign Performance */}
      {marketingDept && (
        <div className="rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Megaphone className="h-3.5 w-3.5" />
            CMO Campaign Performance
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <StatBlock
              label="Content Pieces Produced"
              value={marketingDept.issuesCompleted}
              color="text-blue-400"
            />
            <div className="rounded-lg bg-muted/30 px-3 py-2.5">
              <p className="text-xs text-muted-foreground">Marketing Spend</p>
              <p className="text-2xl font-bold tabular-nums">{formatCents(marketingDept.totalCost)}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Marketing department output for the last 30 days. Issues completed = content pieces produced.
          </p>
        </div>
      )}

      {/* 13. Weekly Trends */}
      <div className="rounded-xl border border-border p-5 space-y-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <LineChart className="h-3.5 w-3.5" />
          Trends (Last 8 Weeks)
        </h3>

        {/* Weekly spend trend - SVG line chart */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Weekly Spend</p>
          <WeeklyLineChart
            data={spendTrendWeeks.map((w) => ({ label: w.label, value: w.cost }))}
            formatValue={(v) => formatCents(v)}
          />
        </div>

        {/* Weekly issues completed trend - SVG bar chart */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Issues Completed per Week</p>
          <WeeklyBarChart
            data={issueTrendWeeks.map((w) => ({ label: w.label, value: w.count }))}
          />
        </div>
      </div>

      {/* 14. Recent Activity */}
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

      {/* 15. Expertise Map */}
      {expertiseMap && expertiseMap.length > 0 && (
        <div className="rounded-xl border border-border p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Brain className="h-3.5 w-3.5" />
            Expertise Map
          </h3>
          <p className="text-[12px] text-muted-foreground">
            Agent topic strengths derived from channel message analysis. Higher scores indicate more decisions and discussion on that topic.
          </p>
          <div className="space-y-3">
            {expertiseMap.slice(0, 8).map((agent) => (
              <div key={agent.agentId} className="space-y-1.5">
                <div className="text-[13px] font-medium text-foreground">{agent.agentName}</div>
                <div className="flex flex-wrap gap-1.5">
                  {agent.topics.slice(0, 5).map((t) => (
                    <span
                      key={t.topic}
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border bg-muted/30 text-muted-foreground"
                      title={`${t.messageCount} messages, ${t.decisionCount} decisions`}
                    >
                      <span className="capitalize">{t.topic}</span>
                      <span className="text-muted-foreground/60">
                        {t.messageCount + t.decisionCount * 2}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Capacity Planning & Forecasting */}
      {issues && agents && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Capacity Planning & Forecasting
          </h2>
          <CapacityPlanning issues={issues} agents={agents} />
        </div>
      )}
    </div>
  );
}

function DORAMetricBlock({
  label,
  value,
  tier,
  description,
}: {
  label: string;
  value: string;
  tier: "elite" | "high" | "medium" | "low";
  description: string;
}) {
  const tierColors: Record<string, string> = {
    elite: "text-emerald-400",
    high: "text-blue-400",
    medium: "text-amber-400",
    low: "text-red-400",
  };
  const tierLabels: Record<string, string> = {
    elite: "Elite",
    high: "High",
    medium: "Medium",
    low: "Low",
  };
  return (
    <div className="rounded-lg bg-muted/30 px-3 py-3 space-y-1">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold tabular-nums", tierColors[tier])}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{description}</p>
      <span className={cn("inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded", tierColors[tier], "bg-current/10")}>
        {tierLabels[tier]}
      </span>
    </div>
  );
}

function StatBlock({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
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

function HealthBreakdownItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className={cn(
        "text-lg font-bold tabular-nums",
        value >= 80 ? "text-emerald-400" :
        value >= 60 ? "text-blue-400" :
        value >= 40 ? "text-amber-400" : "text-red-400",
      )}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Trend Chart Components (pure SVG, no external deps)
// ---------------------------------------------------------------------------

const CHART_W = 560;
const CHART_H = 80;
const CHART_PAD_X = 0;
const CHART_PAD_Y = 8;

function WeeklyLineChart({
  data,
  formatValue,
}: {
  data: Array<{ label: string; value: number }>;
  formatValue: (v: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const stepX = (CHART_W - CHART_PAD_X * 2) / Math.max(n - 1, 1);
  const points = data.map((d, i) => {
    const x = CHART_PAD_X + i * stepX;
    const y = CHART_PAD_Y + (1 - d.value / max) * (CHART_H - CHART_PAD_Y * 2);
    return { x, y, d };
  });
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 20}`}
        className="w-full"
        aria-label="Weekly spend trend chart"
      >
        {/* Grid line at 50% */}
        <line
          x1={CHART_PAD_X}
          y1={CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) / 2}
          x2={CHART_W - CHART_PAD_X}
          y2={CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) / 2}
          stroke="currentColor"
          strokeOpacity={0.1}
          strokeWidth={1}
        />
        {/* Line path */}
        <path d={pathD} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} strokeLinejoin="round" />
        {/* Dots + labels */}
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={3} fill="hsl(var(--primary))" />
            {i === n - 1 && (
              <text
                x={p.x}
                y={p.y - 6}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                opacity={0.7}
              >
                {formatValue(p.d.value)}
              </text>
            )}
            <text
              x={p.x}
              y={CHART_H + 18}
              textAnchor="middle"
              fontSize={8}
              fill="currentColor"
              opacity={0.5}
            >
              {p.d.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function WeeklyBarChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const totalW = CHART_W - CHART_PAD_X * 2;
  const barW = (totalW / n) * 0.65;
  const gap = (totalW / n) * 0.35;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 20}`}
        className="w-full"
        aria-label="Weekly issues completed bar chart"
      >
        {data.map((d, i) => {
          const barH = max > 0 ? ((d.value / max) * (CHART_H - CHART_PAD_Y * 2)) : 0;
          const x = CHART_PAD_X + i * (barW + gap);
          const y = CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) - barH;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={2}
                fill={i === n - 1 ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.4)"}
              />
              {d.value > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill="currentColor"
                  opacity={0.8}
                >
                  {d.value}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={CHART_H + 18}
                textAnchor="middle"
                fontSize={8}
                fill="currentColor"
                opacity={0.5}
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
