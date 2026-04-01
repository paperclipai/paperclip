import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { costsApi } from "../api/costs";
import { goalProgressApi } from "../api/goalProgress";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { cn, formatCents } from "../lib/utils";
import { AlertTriangle, Bot, ChevronDown, ChevronRight, CircleDot, DollarSign, ShieldCheck, Swords, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, PriorityChart, IssueStatusChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@ironworksai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { computeAgentPerformance } from "./AgentPerformance";
import { WelcomeBanner } from "../components/WelcomeBanner";
import { ApiKeyOnboardingBanner } from "../components/ApiKeyOnboardingBanner";

/* ── Activity noise filter + aggregation ── */

function isActivityEventMeaningful(event: { action?: string }): boolean {
  const action = event.action ?? "";
  if (action.startsWith("cost.")) return false;
  return true;
}

interface AggregatedGroup {
  key: string;
  action: string;
  actorName: string;
  count: number;
  models: string[];
  latestEvent: import("@ironworksai/shared").ActivityEvent;
  events: import("@ironworksai/shared").ActivityEvent[];
}

const ACTION_LABELS: Record<string, string> = {
  "cost.reported": "cost events",
  "cost.recorded": "cost events",
  "issue.created": "issues",
  "issue.updated": "issue updates",
  "issue.comment_added": "comments",
  "agent.created": "agents",
  "project.created": "projects",
  "goal.created": "goals",
};

function aggregateActivityEvents(
  events: import("@ironworksai/shared").ActivityEvent[],
  agentMap: Map<string, Agent>,
): (import("@ironworksai/shared").ActivityEvent | AggregatedGroup)[] {
  const result: (import("@ironworksai/shared").ActivityEvent | AggregatedGroup)[] = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    let j = i + 1;
    const fiveMinutes = 5 * 60 * 1000;
    const eventTime = new Date(event.createdAt).getTime();
    while (j < events.length) {
      const next = events[j];
      if (next.action === event.action && next.actorId === event.actorId && Math.abs(eventTime - new Date(next.createdAt).getTime()) < fiveMinutes) j++;
      else break;
    }
    if (j - i >= 3) {
      const groupEvents = events.slice(i, j);
      const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
      const actorName = actor?.name ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown");
      const models = new Set<string>();
      for (const e of groupEvents) {
        const model = (e.details as Record<string, unknown> | null)?.model as string | undefined;
        if (model) models.add(model);
      }
      result.push({ key: `agg-${event.id}`, action: event.action, actorName, count: j - i, models: [...models], latestEvent: event, events: groupEvents });
      i = j;
    } else {
      result.push(event);
      i++;
    }
  }
  return result;
}

function isAggregated(item: import("@ironworksai/shared").ActivityEvent | AggregatedGroup): item is AggregatedGroup {
  return "count" in item && "key" in item;
}

/* ── Main component ── */

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const [expandedAgg, setExpandedAgg] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "War Room" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: windowSpend } = useQuery({
    queryKey: queryKeys.usageWindowSpend(selectedCompanyId!),
    queryFn: () => costsApi.windowSpend(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: costsByAgent } = useQuery({
    queryKey: [...queryKeys.costs(selectedCompanyId!), "by-agent"],
    queryFn: () => costsApi.byAgent(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: goalsProgress } = useQuery({
    queryKey: ["goals", "progress", selectedCompanyId!],
    queryFn: () => goalProgressApi.batch(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  /* ── Maps ── */

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  /* ── Derived data ── */

  const filteredActivity = useMemo(
    () => (activity ?? []).filter(isActivityEventMeaningful).slice(0, 20),
    [activity],
  );

  const recentActivity = filteredActivity;

  const aggregatedActivity = useMemo(
    () => aggregateActivityEvents(filteredActivity, agentMap).slice(0, 12),
    [filteredActivity, agentMap],
  );

  // Blocked issues
  const blockedIssues = useMemo(
    () => (issues ?? []).filter((i) => i.status === "blocked"),
    [issues],
  );

  // Failed runs (last 24h)
  const failedRuns = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (runs ?? []).filter(
      (r) => r.status === "failed" && new Date(r.createdAt).getTime() > cutoff,
    );
  }, [runs]);

  const needsAttention = blockedIssues.length > 0 || failedRuns.length > 0;

  // Today's spend from windowSpend (24h window)
  const todaySpendCents = useMemo(() => {
    if (!windowSpend) return 0;
    return windowSpend
      .filter((r) => r.window === "24h")
      .reduce((sum, r) => sum + r.costCents, 0);
  }, [windowSpend]);

  const weekSpendCents = useMemo(() => {
    if (!windowSpend) return 0;
    return windowSpend
      .filter((r) => r.window === "7d")
      .reduce((sum, r) => sum + r.costCents, 0);
  }, [windowSpend]);

  const dailyAvgCents = weekSpendCents > 0 ? Math.round(weekSpendCents / 7) : 0;
  const spendDeltaPercent = dailyAvgCents > 0
    ? Math.round(((todaySpendCents - dailyAvgCents) / dailyAvgCents) * 100)
    : 0;

  // Agent efficiency via shared performance computation
  const agentPerfRows = useMemo(
    () => computeAgentPerformance(agents ?? [], issues ?? [], costsByAgent ?? [], "30d"),
    [agents, issues, costsByAgent],
  );

  const agentEfficiency = agentPerfRows.filter((r) => r.totalSpendCents > 0 || r.tasksDone > 0).slice(0, 6);

  const teamAvgCostPerTask = useMemo(() => {
    const withTasks = agentEfficiency.filter((a) => a.costPerTask !== null);
    if (withTasks.length === 0) return null;
    return withTasks.reduce((s, a) => s + a.costPerTask!, 0) / withTasks.length;
  }, [agentEfficiency]);

  const teamAvgCloseH = useMemo(() => {
    const withTime = agentEfficiency.filter((a) => a.avgCloseH !== null);
    if (withTime.length === 0) return null;
    return withTime.reduce((s, a) => s + a.avgCloseH!, 0) / withTime.length;
  }, [agentEfficiency]);

  // Project activity breakdown
  const projectActivity = useMemo(() => {
    if (!issues || !projects) return [];
    const countByProject = new Map<string, number>();
    let noProject = 0;
    for (const issue of issues) {
      if (issue.status === "cancelled") continue;
      if (issue.projectId) {
        countByProject.set(issue.projectId, (countByProject.get(issue.projectId) ?? 0) + 1);
      } else {
        noProject++;
      }
    }
    const total = [...countByProject.values()].reduce((s, v) => s + v, 0) + noProject;
    if (total === 0) return [];

    const entries = projects
      .filter((p) => countByProject.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color ?? "#6366f1",
        count: countByProject.get(p.id)!,
        percent: Math.round((countByProject.get(p.id)! / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);

    return entries;
  }, [issues, projects]);

  const totalProjectIssues = projectActivity.reduce((s, p) => s + p.count, 0);

  // Active goals
  const activeGoals = useMemo(
    () => (goalsProgress ?? []).filter((g) => g.status === "active" || g.status === "planned"),
    [goalsProgress],
  );

  /* ── Activity animation ── */

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) window.clearTimeout(timer);
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;
    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((e) => e.id);
    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }
    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) { for (const id of currentIds) seen.add(id); return; }
    setAnimatedActivityIds((prev) => { const next = new Set(prev); for (const id of newIds) next.add(id); return next; });
    for (const id of newIds) seen.add(id);
    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => { const next = new Set(prev); for (const id of newIds) next.delete(id); return next; });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => () => { for (const t of activityAnimationTimersRef.current) window.clearTimeout(t); }, []);

  /* ── Empty states ── */

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={Swords}
          message="Welcome to Ironworks. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return <EmptyState icon={Swords} message="Create or select a company to view the War Room." />;
  }

  if (isLoading) return <PageSkeleton variant="dashboard" />;

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      <WelcomeBanner />
      <ApiKeyOnboardingBanner />
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">You have no agents.</p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {/* ── 1. AGENTS ── */}
      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {/* Budget incident banner */}
          {data.budgets.activeIncidents > 0 && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">Open budgets</Link>
            </div>
          )}

          {/* ── 2. STATS ROW ── */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={<span>{data.agents.running} running, {data.agents.paused} paused, {data.agents.error} errors</span>}
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks Active"
              to="/issues"
              description={<span>{data.tasks.open} open, {data.tasks.blocked} blocked</span>}
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={<span>{data.costs.monthBudgetCents > 0 ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget` : "Unlimited budget"}</span>}
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={<span>{data.budgets.pendingApprovals > 0 ? `${data.budgets.pendingApprovals} budget overrides awaiting board review` : "Awaiting board review"}</span>}
            />
          </div>

          {/* ── 3. ATTENTION REQUIRED ── */}
          {needsAttention && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4 space-y-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide flex items-center gap-2 text-red-400">
                <AlertTriangle className="h-4 w-4" />
                Attention Required
              </h3>
              <div className="space-y-1.5">
                {blockedIssues.slice(0, 5).map((issue) => (
                  <Link
                    key={issue.id}
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-red-500/15 bg-red-500/[0.04] px-3 py-2 text-sm no-underline text-inherit hover:bg-red-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                      <span className="font-mono text-xs text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                      <span className="truncate">{issue.title}</span>
                    </div>
                    <span className="text-xs text-red-400 shrink-0">Blocked</span>
                  </Link>
                ))}
                {failedRuns.slice(0, 3).map((run) => (
                  <Link
                    key={run.id}
                    to={`/agents/${run.agentId}/runs/${run.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-3 py-2 text-sm no-underline text-inherit hover:bg-amber-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                      <span className="truncate">Run failed — {agentMap.get(run.agentId)?.name ?? "Agent"}</span>
                    </div>
                    <span className="text-xs text-amber-400 shrink-0">View run</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── 4. METRICS ROW ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Today's Spend */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today's Spend</h4>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{formatCents(todaySpendCents)}</span>
                <span className="text-xs text-muted-foreground">today</span>
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <span>7-day avg</span>
                  <span>{formatCents(dailyAvgCents)}/day</span>
                </div>
                {spendDeltaPercent !== 0 && (
                  <div className="flex justify-between">
                    <span>vs average</span>
                    <span className={spendDeltaPercent > 20 ? "text-amber-400" : spendDeltaPercent < -20 ? "text-emerald-400" : ""}>
                      {spendDeltaPercent > 0 ? "↑" : "↓"} {Math.abs(spendDeltaPercent)}%
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Week total</span>
                  <span>{formatCents(weekSpendCents)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Month total</span>
                  <span>{formatCents(data.costs.monthSpendCents)}</span>
                </div>
              </div>
            </div>

            {/* Agent Efficiency */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Efficiency</h4>
                <Link to="/performance" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Details</Link>
              </div>
              {agentEfficiency.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agent cost data yet.</p>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="grid grid-cols-[24px_1fr_50px_45px] gap-1 text-[10px] text-muted-foreground uppercase tracking-wider pb-1 border-b border-border/50">
                      <span></span>
                      <span>Agent</span>
                      <span className="text-right">$/task</span>
                      <span className="text-right">Time</span>
                    </div>
                    {agentEfficiency.map((a) => (
                      <div key={a.agentId} className="grid grid-cols-[24px_1fr_50px_45px] gap-1 text-xs py-0.5 items-center">
                        <span className={cn(
                          "inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold",
                          a.rating === "A" ? "text-emerald-400 bg-emerald-500/10" :
                          a.rating === "B" ? "text-blue-400 bg-blue-500/10" :
                          a.rating === "C" ? "text-amber-400 bg-amber-500/10" :
                          a.rating === "D" ? "text-orange-400 bg-orange-500/10" :
                          "text-red-400 bg-red-500/10",
                        )}>
                          {a.rating}
                        </span>
                        <span className="truncate">{a.name}</span>
                        <span className="text-right text-muted-foreground">
                          {a.costPerTask !== null ? formatCents(Math.round(a.costPerTask)) : "—"}
                        </span>
                        <span className="text-right text-muted-foreground">
                          {a.avgCloseH !== null ? `${a.avgCloseH.toFixed(1)}h` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 pt-2 space-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Team avg</span>
                      <span>{teamAvgCostPerTask !== null ? `${formatCents(Math.round(teamAvgCostPerTask))}/task` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Avg close time</span>
                      <span>{teamAvgCloseH !== null ? `${teamAvgCloseH.toFixed(1)}h` : "—"}</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Project Activity */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project Activity</h4>
              {projectActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No project data yet.</p>
              ) : (
                <>
                  <div className="space-y-2.5">
                    {projectActivity.slice(0, 5).map((p) => (
                      <div key={p.id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                            <span className="truncate">{p.name}</span>
                          </div>
                          <span className="text-muted-foreground shrink-0">{p.percent}%</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-[width] duration-300"
                            style={{ width: `${p.percent}%`, backgroundColor: p.color }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 pt-2 text-xs text-muted-foreground">
                    {totalProjectIssues} issues across {projectActivity.length} projects
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── 5. PROGRESS ROW ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Goals Progress */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goals Progress</h4>
                <Link to="/goals" className="text-xs text-muted-foreground hover:text-foreground transition-colors">View all</Link>
              </div>
              {activeGoals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active goals.</p>
              ) : (
                <div className="space-y-4">
                  {activeGoals.slice(0, 5).map((goal) => (
                    <Link key={goal.goalId} to={`/goals/${goal.goalId}`} className="block space-y-1.5 no-underline text-inherit hover:opacity-80 transition-opacity">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate font-medium">{goal.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">{goal.progressPercent}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-300",
                            goal.progressPercent === 100 ? "bg-emerald-500" : goal.blockedIssues > 0 ? "bg-amber-500" : "bg-blue-500",
                          )}
                          style={{ width: `${goal.progressPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{goal.completedIssues}/{goal.totalIssues} done</span>
                        {goal.blockedIssues > 0 && (
                          <span className="text-amber-400">· {goal.blockedIssues} blocked</span>
                        )}
                        {goal.blockedIssues === 0 && goal.progressPercent < 100 && (
                          <span className="text-emerald-400">· on track</span>
                        )}
                        {goal.progressPercent === 100 && (
                          <span className="text-emerald-400">· complete</span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Issues Overview */}
            <div className="rounded-xl border border-border p-4 space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Issues Overview</h4>
              <ChartCard title="Issues by Priority" subtitle="Last 14 days">
                <PriorityChart issues={issues ?? []} />
              </ChartCard>
              <ChartCard title="Issues by Status" subtitle="Last 14 days">
                <IssueStatusChart issues={issues ?? []} />
              </ChartCard>
            </div>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          {/* ── 6. RECENT ACTIVITY ── */}
          {aggregatedActivity.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Recent Activity
                </h3>
                <Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                  View all activity
                </Link>
              </div>
              <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                {aggregatedActivity.map((item) =>
                  isAggregated(item) ? (
                    <div key={item.key}>
                      <button
                        onClick={() => setExpandedAgg((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                          return next;
                        })}
                        className="w-full px-4 py-2.5 text-sm flex items-center justify-between hover:bg-accent/30 transition-colors text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {expandedAgg.has(item.key) ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0">
                            {item.count}
                          </span>
                          <span>
                            <span className="font-medium">{item.actorName}</span>
                            <span className="text-muted-foreground ml-1">
                              logged {item.count} {ACTION_LABELS[item.action] ?? item.action.replace(/[._]/g, " ")}
                            </span>
                            {item.models.length > 0 && (
                              <span className="text-muted-foreground ml-1">
                                — {item.models.slice(0, 3).join(", ")}
                              </span>
                            )}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">
                          {new Date(item.latestEvent.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </button>
                      {expandedAgg.has(item.key) && (
                        <div className="border-t border-border/50 bg-muted/10">
                          {item.events.map((event) => (
                            <ActivityRow
                              key={event.id}
                              event={event}
                              agentMap={agentMap}
                              entityNameMap={entityNameMap}
                              entityTitleMap={entityTitleMap}
                              className="pl-12"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ActivityRow
                      key={item.id}
                      event={item}
                      agentMap={agentMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(item.id) ? "activity-row-enter" : undefined}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
