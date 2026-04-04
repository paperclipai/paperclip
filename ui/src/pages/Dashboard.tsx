import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { costsApi } from "../api/costs";
import { goalProgressApi } from "../api/goalProgress";
import { hiringApi } from "../api/hiring";
import { approvalsApi } from "../api/approvals";
import { announcementsApi } from "../api/announcements";
import { velocityApi, type VelocityWeek } from "../api/velocity";
import { executiveApi, type SmartAlert } from "../api/executive";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { Button } from "@/components/ui/button";
import { cn, formatCents } from "../lib/utils";
import { AlertTriangle, Bot, Briefcase, ChevronDown, ChevronRight, CircleDot, DollarSign, Megaphone, Radio, ShieldCheck, Swords, PauseCircle, Users, UserPlus, Zap } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, PriorityChart, IssueStatusChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue, LiveEvent } from "@ironworksai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { computeAgentPerformance } from "./AgentPerformance";
import { WelcomeBanner } from "../components/WelcomeBanner";
import { ApiKeyOnboardingBanner } from "../components/ApiKeyOnboardingBanner";

/* ── Live Feed types ── */

interface LiveFeedEvent {
  id: string;
  sseType: string;
  receivedAt: Date;
  event: LiveEvent;
}

const MAX_LIVE_EVENTS = 50;

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

/* ── Velocity Chart ── */

function VelocityChart({ weeks }: { weeks: VelocityWeek[] }) {
  const maxVal = Math.max(...weeks.map((w) => w.issuesCompleted + w.issuesCancelled), 1);
  const chartW = 400;
  const chartH = 120;
  const barGap = 4;
  const barW = Math.max(4, (chartW - barGap * weeks.length) / weeks.length);
  const labelY = chartH + 14;

  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH + 24}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {weeks.map((w, i) => {
          const total = w.issuesCompleted + w.issuesCancelled;
          const totalH = (total / maxVal) * chartH;
          const completedH = (w.issuesCompleted / maxVal) * chartH;
          const cancelledH = (w.issuesCancelled / maxVal) * chartH;
          const x = i * (barW + barGap) + barGap / 2;

          const d = new Date(w.weekStart);
          const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const showLabel = i === 0 || i === weeks.length - 1 || i % 3 === 0;

          return (
            <g key={w.weekStart}>
              <title>{label}: {w.issuesCompleted} completed, {w.issuesCancelled} cancelled</title>
              {completedH > 0 && (
                <rect
                  x={x}
                  y={chartH - totalH}
                  width={barW}
                  height={completedH}
                  rx={2}
                  className="fill-emerald-500"
                />
              )}
              {cancelledH > 0 && (
                <rect
                  x={x}
                  y={chartH - cancelledH}
                  width={barW}
                  height={cancelledH}
                  rx={2}
                  className="fill-muted-foreground/30"
                />
              )}
              {total === 0 && (
                <rect
                  x={x}
                  y={chartH - 2}
                  width={barW}
                  height={2}
                  rx={1}
                  className="fill-muted/30"
                />
              )}
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={labelY}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[8px]"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          Completed
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
          Cancelled
        </span>
      </div>
    </div>
  );
}

/* ── Department Mini-Chart ── */

const DEPT_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f97316",
  "#06b6d4", "#10b981", "#eab308", "#ef4444",
];

function DepartmentMiniChart({ departments }: { departments: Array<{ name: string; count: number }> }) {
  const maxCount = Math.max(...departments.map((d) => d.count), 1);

  return (
    <div className="space-y-2">
      {departments.map((dept, i) => (
        <div key={dept.name} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate">{dept.name}</span>
            <span className="text-muted-foreground tabular-nums shrink-0 ml-2">{dept.count}</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${(dept.count / maxCount) * 100}%`,
                backgroundColor: DEPT_COLORS[i % DEPT_COLORS.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main component ── */

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding, openHireAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const [expandedAgg, setExpandedAgg] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  /* ── Live Feed state ── */
  const [liveMode, setLiveMode] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveFeedEvent[]>([]);
  const liveFeedBottomRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const toggleLiveMode = useCallback(() => {
    setLiveMode((prev) => !prev);
  }, []);

  /* Open / close SSE connection when liveMode or company changes */
  useEffect(() => {
    // Close any existing connection first
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setLiveConnected(false);
    }

    if (!liveMode || !selectedCompanyId) return;

    const es = new EventSource(`/api/companies/${selectedCompanyId}/events`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setLiveConnected(true);
    };

    es.onerror = () => {
      setLiveConnected(false);
    };

    function handleLiveEvent(sseType: string) {
      return (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data as string) as LiveEvent;
          const feedEntry: LiveFeedEvent = {
            id: `${Date.now()}-${Math.random()}`,
            sseType,
            receivedAt: new Date(),
            event,
          };
          setLiveEvents((prev) => [...prev.slice(-(MAX_LIVE_EVENTS - 1)), feedEntry]);
        } catch {
          // Ignore malformed events
        }
      };
    }

    es.addEventListener("activity", handleLiveEvent("activity"));
    es.addEventListener("agent_run", handleLiveEvent("agent_run"));
    es.addEventListener("heartbeat_run_event", handleLiveEvent("heartbeat_run_event"));

    return () => {
      es.close();
      eventSourceRef.current = null;
      setLiveConnected(false);
    };
  }, [liveMode, selectedCompanyId]);

  /* Auto-scroll to newest live event */
  useEffect(() => {
    if (liveEvents.length > 0 && liveFeedBottomRef.current) {
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      liveFeedBottomRef.current.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    }
  }, [liveEvents]);

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

  const { data: headcount } = useQuery({
    queryKey: queryKeys.headcount(selectedCompanyId!),
    queryFn: () => agentsApi.headcount(selectedCompanyId!),
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

  const { data: pendingApprovalsList } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: announcements } = useQuery({
    queryKey: queryKeys.announcements.list(selectedCompanyId!),
    queryFn: () => announcementsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const { data: velocity } = useQuery({
    queryKey: ["velocity", selectedCompanyId!],
    queryFn: () => velocityApi.get(selectedCompanyId!, 12),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const queryClient = useQueryClient();

  const { data: smartAlerts } = useQuery({
    queryKey: ["alerts", selectedCompanyId!],
    queryFn: () => executiveApi.getAlerts(selectedCompanyId!, "medium"),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const resolveAlertMutation = useMutation({
    mutationFn: (alertId: string) => executiveApi.resolveAlert(selectedCompanyId!, alertId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alerts", selectedCompanyId!] });
    },
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

  // Department breakdown
  const departmentBreakdown = useMemo(() => {
    if (!agents) return [];
    const counts = new Map<string, number>();
    for (const a of agents) {
      if (a.status === "terminated") continue;
      const dept = (a as { department?: string | null }).department ?? "Unassigned";
      counts.set(dept, (counts.get(dept) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [agents]);

  // Active goals
  const activeGoals = useMemo(
    () => (goalsProgress ?? []).filter((g) => g.status === "active" || g.status === "planned"),
    [goalsProgress],
  );

  // AI Workforce Impact metrics
  const impactMetrics = useMemo(() => {
    // Count issues completed this week
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const doneThisWeek = (issues ?? []).filter(
      (i) => i.status === "done" && i.completedAt && new Date(i.completedAt).getTime() > weekAgo,
    ).length;
    const humanHoursEquiv = doneThisWeek * 2;
    const costPerTask = doneThisWeek > 0 ? weekSpendCents / doneThisWeek : 0;
    const costPerHumanHour = humanHoursEquiv > 0 ? weekSpendCents / humanHoursEquiv : 0;
    return { doneThisWeek, humanHoursEquiv, costPerTask, costPerHumanHour };
  }, [issues, weekSpendCents]);

  // CEO Decisions Needed
  const pendingHiringCount = useMemo(
    () => (hiringRequests ?? []).filter((r) => r.status === "pending" || r.status === "open").length,
    [hiringRequests],
  );
  const pendingApprovalsCount = (pendingApprovalsList ?? []).length;
  const hasDecisionsNeeded = pendingHiringCount > 0 || pendingApprovalsCount > 0;

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
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

      {/* ── ANNOUNCEMENTS ── */}
      {announcements && announcements.length > 0 && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-400 flex items-center gap-2">
              <Megaphone className="h-3.5 w-3.5" />
              Announcements
            </h4>
            <Link to="/knowledge" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              See all
            </Link>
          </div>
          <div className="space-y-1.5">
            {announcements.slice(0, 3).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-blue-500/15 bg-blue-500/[0.04] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{a.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })}
                    {a.createdByUserId ? " - Board" : a.createdByAgentId ? " - Agent" : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">You have no agents.</p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 3, companyId: selectedCompanyId! })}
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
                  <p className="text-sm text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">Open budgets</Link>
            </div>
          )}

          {/* ── 2. STATS ROW ── */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
            {headcount && (
              <div className="relative">
                <MetricCard
                  icon={Users}
                  value={headcount.fte + headcount.contractor}
                  label="Headcount"
                  to="/agents"
                  description={<span>{headcount.fte} Full-Time, {headcount.contractor} Contractors</span>}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-2 right-2 h-6 w-6 p-0"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); openHireAgent(); }}
                  title="Hire agent"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
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
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
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
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Blocked"><span className="sr-only">Blocked</span></span>
                      <span className="font-mono text-sm text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>
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
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Failed"><span className="sr-only">Failed</span></span>
                      <span className="truncate">Run failed — {agentMap.get(run.agentId)?.name ?? "Agent"}</span>
                    </div>
                    <span className="text-xs text-amber-400 shrink-0">View run</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── ALERTS ── */}
          {smartAlerts && smartAlerts.length > 0 && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide flex items-center gap-2 text-amber-400">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  Alerts
                  <span className="inline-flex items-center justify-center rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-bold min-w-[18px] px-1.5 py-0.5">
                    {smartAlerts.length}
                  </span>
                </h3>
              </div>
              <div className="space-y-1.5">
                {smartAlerts.map((alert: SmartAlert) => (
                  <div
                    key={alert.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
                      alert.severity === "critical"
                        ? "border-red-500/20 bg-red-500/[0.06]"
                        : alert.severity === "high"
                          ? "border-amber-500/20 bg-amber-500/[0.06]"
                          : "border-yellow-500/20 bg-yellow-500/[0.06]",
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          alert.severity === "critical"
                            ? "bg-red-500"
                            : alert.severity === "high"
                              ? "bg-amber-500"
                              : "bg-yellow-500",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{alert.title}</p>
                        {alert.description && (
                          <p className="text-xs text-muted-foreground truncate">{alert.description}</p>
                        )}
                      </div>
                    </div>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground shrink-0 transition-colors underline underline-offset-2"
                      onClick={() => resolveAlertMutation.mutate(alert.id)}
                      disabled={resolveAlertMutation.isPending}
                    >
                      Resolve
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 4. METRICS ROW ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {/* Today's Spend */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today's Spend</h4>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">{formatCents(todaySpendCents)}</span>
                <span className="text-sm text-muted-foreground">today</span>
              </div>
              <div className="space-y-1.5 text-sm text-muted-foreground tabular-nums">
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
                      <div key={a.agentId} className="grid grid-cols-[24px_1fr_50px_45px] gap-1 text-sm py-0.5 items-center">
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
                        <span className="text-right text-muted-foreground tabular-nums">
                          {a.costPerTask !== null ? formatCents(Math.round(a.costPerTask)) : "—"}
                        </span>
                        <span className="text-right text-muted-foreground tabular-nums">
                          {a.avgCloseH !== null ? `${a.avgCloseH.toFixed(1)}h` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 pt-2 space-y-1 text-sm text-muted-foreground tabular-nums">
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
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                            <span className="truncate">{p.name}</span>
                          </div>
                          <span className="text-muted-foreground shrink-0 tabular-nums">{p.percent}%</span>
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
                  <div className="border-t border-border/50 pt-2 text-sm text-muted-foreground">
                    {totalProjectIssues} issues across {projectActivity.length} projects
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── 4b. AI WORKFORCE IMPACT ── */}
          {(impactMetrics.doneThisWeek > 0 || weekSpendCents > 0) && (
            <div className="rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  <Zap className="h-3.5 w-3.5" />
                  AI Workforce Impact
                </h4>
                <Link to="/performance" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Details</Link>
              </div>
              <p className="text-sm text-foreground">
                Your {headcount ? headcount.fte + headcount.contractor : agents?.length ?? 0} agents completed{" "}
                <span className="font-semibold">{impactMetrics.doneThisWeek}</span> tasks this week
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="space-y-0.5">
                  <p className="text-lg font-bold tabular-nums">{impactMetrics.humanHoursEquiv}h</p>
                  <p className="text-[11px] text-muted-foreground">Human-hours equivalent</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-lg font-bold tabular-nums">{formatCents(weekSpendCents)}</p>
                  <p className="text-[11px] text-muted-foreground">Total cost this week</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-lg font-bold tabular-nums">
                    {impactMetrics.doneThisWeek > 0 ? formatCents(Math.round(impactMetrics.costPerTask)) : "-"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Cost per task</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-lg font-bold tabular-nums">
                    {impactMetrics.humanHoursEquiv > 0 ? formatCents(Math.round(impactMetrics.costPerHumanHour)) : "-"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Cost per human-hour</p>
                </div>
              </div>
              {impactMetrics.humanHoursEquiv > 0 && (
                <p className="text-xs text-muted-foreground border-t border-border/50 pt-2">
                  Your AI workforce operates at{" "}
                  <span className="font-medium text-foreground">
                    {formatCents(Math.round(impactMetrics.costPerHumanHour))}/human-hour equivalent
                  </span>
                </p>
              )}
            </div>
          )}

          {/* ── 4c. DECISIONS NEEDED (CEO) ── */}
          {hasDecisionsNeeded && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-400 flex items-center gap-2">
                <Briefcase className="h-3.5 w-3.5" />
                Decisions Needed
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {pendingHiringCount > 0 && (
                  <Link
                    to="/hiring"
                    className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-4 py-3 no-underline text-inherit hover:bg-amber-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <UserPlus className="h-4 w-4 text-amber-400 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">{pendingHiringCount} hiring request{pendingHiringCount !== 1 ? "s" : ""}</p>
                        <p className="text-xs text-muted-foreground">Pending review</p>
                      </div>
                    </div>
                    <span className="text-xs text-amber-400 shrink-0">Review</span>
                  </Link>
                )}
                {pendingApprovalsCount > 0 && (
                  <Link
                    to="/approvals"
                    className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-4 py-3 no-underline text-inherit hover:bg-amber-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">{pendingApprovalsCount} pending approval{pendingApprovalsCount !== 1 ? "s" : ""}</p>
                        <p className="text-xs text-muted-foreground">Awaiting board review</p>
                      </div>
                    </div>
                    <span className="text-xs text-amber-400 shrink-0">Review</span>
                  </Link>
                )}
              </div>
            </div>
          )}

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
                        <span className="text-sm text-muted-foreground shrink-0 ml-2">{goal.progressPercent}%</span>
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

          {/* ── 5b. VELOCITY + DEPARTMENT ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Velocity Chart */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team Velocity (12 weeks)</h4>
              {!velocity || velocity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No velocity data yet.</p>
              ) : (
                <VelocityChart weeks={velocity} />
              )}
            </div>

            {/* Department Breakdown */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents by Department</h4>
              {departmentBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agents yet.</p>
              ) : (
                <DepartmentMiniChart departments={departmentBreakdown} />
              )}
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
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Recent Activity
                  </h3>
                  <button
                    onClick={toggleLiveMode}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      liveMode
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                        : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/20",
                    )}
                    aria-pressed={liveMode}
                    title={liveMode ? "Disable live feed" : "Enable live feed"}
                  >
                    {liveMode && liveConnected ? (
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      </span>
                    ) : (
                      <Radio className="h-3 w-3 shrink-0" />
                    )}
                    Live
                  </button>
                </div>
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
        {/* ── 7. LIVE FEED ── */}
        {liveMode && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Live Feed
                </h3>
                {liveConnected ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
                    <span className="relative flex h-1.5 w-1.5 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                    Connected
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">Connecting...</span>
                )}
              </div>
              {liveEvents.length > 0 && (
                <button
                  onClick={() => setLiveEvents([])}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="rounded-lg border border-border overflow-hidden">
              {liveEvents.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                  Waiting for events...
                </div>
              ) : (
                <div className="divide-y divide-border max-h-80 overflow-y-auto">
                  {liveEvents.map((entry) => (
                    <LiveFeedRow
                      key={entry.id}
                      entry={entry}
                      agentMap={agentMap}
                    />
                  ))}
                  <div ref={liveFeedBottomRef} />
                </div>
              )}
            </div>
          </div>
        )}
      </>
      )}
    </div>
  );
}

/* ── Live Feed row component ── */

function liveFeedEventColor(sseType: string, payload: Record<string, unknown>): string {
  if (sseType === "agent_run") {
    const status = payload.status as string | undefined;
    if (status === "completed" || status === "done") return "text-emerald-400";
    if (status === "failed" || status === "error") return "text-red-400";
    return "text-blue-400";
  }
  if (sseType === "activity") {
    const action = payload.action as string | undefined;
    if (action?.includes("completed") || action?.includes("done")) return "text-emerald-400";
    if (action?.includes("fail") || action?.includes("error") || action?.includes("blocked")) return "text-red-400";
  }
  return "text-muted-foreground";
}

function liveFeedDescription(
  sseType: string,
  event: LiveEvent,
  agentMap: Map<string, Agent>,
): string {
  const payload = event.payload;
  if (sseType === "activity") {
    const action = (payload.action as string | undefined) ?? event.type;
    const agentId = payload.agentId as string | undefined;
    const entityType = (payload.entityType as string | undefined) ?? "";
    const entityId = (payload.entityId as string | undefined) ?? "";
    const actorName = agentId
      ? (agentMap.get(agentId)?.name ?? agentId.slice(0, 8))
      : (payload.actorId as string | undefined) ?? "System";
    const label = action.replace(/[._]/g, " ");
    const entity = entityType ? `${entityType} ${entityId.slice(0, 8)}` : "";
    return entity ? `${actorName} - ${label} (${entity})` : `${actorName} - ${label}`;
  }
  if (sseType === "agent_run") {
    const status = (payload.status as string | undefined) ?? "";
    const agentId = payload.agentId as string | undefined;
    const agentName = agentId ? (agentMap.get(agentId)?.name ?? agentId.slice(0, 8)) : "Agent";
    return status ? `${agentName} run ${status}` : `${agentName} run updated`;
  }
  return event.type.replace(/[._]/g, " ");
}

function LiveFeedRow({
  entry,
  agentMap,
}: {
  entry: LiveFeedEvent;
  agentMap: Map<string, Agent>;
}) {
  const color = liveFeedEventColor(entry.sseType, entry.event.payload);
  const description = liveFeedDescription(entry.sseType, entry.event, agentMap);
  const timeStr = entry.receivedAt.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm live-feed-row-enter hover:bg-accent/20 transition-colors">
      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70 font-mono w-[62px]">
        {timeStr}
      </span>
      <span className={cn("shrink-0 h-1.5 w-1.5 rounded-full", {
        "bg-emerald-500": color === "text-emerald-400",
        "bg-red-500": color === "text-red-400",
        "bg-blue-500": color === "text-blue-400",
        "bg-muted-foreground/50": color === "text-muted-foreground",
      })} />
      <span className={cn("truncate", color)}>{description}</span>
    </div>
  );
}
