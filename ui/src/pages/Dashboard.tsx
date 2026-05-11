import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import {
  ArrowRight,
  Bot,
  CircleDot,
  DollarSign,
  ShieldCheck,
  LayoutDashboard,
  PauseCircle,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  IssueStatusChart,
  SuccessRateChart,
} from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { Badge } from "@/components/ui/badge";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies, selectedCompany } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(
    new Set(),
  );
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.activity(selectedCompanyId!),
      { limit: DASHBOARD_ACTIVITY_LIMIT },
    ],
    queryFn: () =>
      activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
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

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(
    () => (activity ?? []).slice(0, 10),
    [activity],
  );

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current =
        activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? [])
      map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Bizbox. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState
        icon={LayoutDashboard}
        message="Create or select a company to view the dashboard."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const boardPulse = data
    ? [
        {
          label: "Active now",
          value: data.agents.running,
          tone: "primary" as const,
        },
        {
          label: "Blocked tasks",
          value: data.tasks.blocked,
          tone:
            data.tasks.blocked > 0
              ? ("warning" as const)
              : ("neutral" as const),
        },
        {
          label: "Approvals waiting",
          value: data.pendingApprovals + data.budgets.pendingApprovals,
          tone:
            data.pendingApprovals + data.budgets.pendingApprovals > 0
              ? ("warning" as const)
              : ("neutral" as const),
        },
        {
          label: "Monthly spend",
          value: formatCents(data.costs.monthSpendCents),
          tone: "neutral" as const,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() =>
              openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })
            }
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          <section className="brand-panel overflow-hidden rounded-[2rem]">
            <div className="grid gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.9fr)] lg:px-7 lg:py-7">
              <div className="relative min-w-0">
                <div className="brand-chip inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  Live company overview
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  {selectedCompany?.name ?? "Your AI company"} is running on
                  Bizbox.
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                  {selectedCompany?.description?.trim()
                    ? selectedCompany.description
                    : "Track agents, work, approvals, and spend from one board so a human can understand what the company is doing at a glance."}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Link
                    to="/issues"
                    className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/[0.16] px-4 py-2 text-sm font-medium text-foreground transition hover:brightness-110"
                  >
                    Open work queue
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    to="/agents/all"
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                  >
                    Inspect agents
                  </Link>
                  <Link
                    to="/approvals/pending"
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                  >
                    Board approvals
                  </Link>
                </div>
              </div>
              <div className="brand-panel-subtle grid gap-3 rounded-[1.6rem] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Board pulse
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The first screen should tell you what is active, blocked,
                      and expensive.
                    </p>
                  </div>
                  {data.budgets.activeIncidents > 0 ||
                  data.tasks.blocked > 0 ||
                  data.pendingApprovals + data.budgets.pendingApprovals > 0 ? (
                    <Badge variant="destructive" className="inline-flex items-center gap-1 uppercase px-3 py-1.5">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      Attention needed
                    </Badge>
                  ) : (

                    <Badge variant="outline" className="inline-flex items-center gap-1 uppercase px-3 py-1.5 text-emerald-700 dark:text-emerald-200 border-emerald-500/20 bg-emerald-500/10">
                      Company healthy
                    </Badge>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {boardPulse.map((item) => (
                    <div
                      key={item.label}
                      className={cn(
                        "rounded-[1.25rem] border px-4 py-3",
                        item.tone === "primary"
                          ? "border-primary/20 bg-primary/[0.12]"
                          : item.tone === "warning"
                            ? "border-amber-400/18 bg-amber-400/[0.08]"
                            : "border-border bg-muted/30",
                      )}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {item.label}
                      </div>
                      <div className="mt-2 text-2xl font-semibold text-foreground">
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-[1.4rem] border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.14),rgba(255,255,255,0.02))] px-4 py-4">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-foreground dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident
                    {data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-muted-foreground dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused ·{" "}
                    {data.budgets.pausedProjects} projects paused ·{" "}
                    {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link
                to="/costs"
                className="text-sm underline underline-offset-2 text-foreground dark:text-red-100"
              >
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={Bot}
              value={
                data.agents.active +
                data.agents.running +
                data.agents.paused +
                data.agents.error
              }
              label="Agents available to the company"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks moving right now"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked{", "}
                  {data.tasks.awaitingHuman} awaiting human
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Current month spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Board approvals waiting"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="mb-1 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Recent Activity
                </h3>
                <p className="mb-3 text-sm text-muted-foreground">
                  Recent board-visible changes across agents, tasks, and
                  approvals.
                </p>
                <div className="brand-panel overflow-hidden rounded-[1.5rem] divide-y divide-border">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={
                        animatedActivityIds.has(event.id)
                          ? "activity-row-enter"
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="mb-1 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Recent Tasks
              </h3>
              <p className="mb-3 text-sm text-muted-foreground">
                The freshest work items across the company, sorted by latest
                movement.
              </p>
              {recentIssues.length === 0 ? (
                <div className="brand-panel rounded-[1.5rem] p-4">
                  <p className="text-sm text-muted-foreground">
                    No tasks yet. Create the first issue to make the company
                    legible.
                  </p>
                </div>
              ) : (
                <div className="brand-panel overflow-hidden rounded-[1.5rem] divide-y divide-border">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex">
                              <StatusIcon status={issue.status} />
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId &&
                              (() => {
                                const name = agentName(issue.assigneeAgentId);
                                return name ? (
                                  <span className="hidden sm:inline-flex">
                                    <Identity name={name} size="sm" />
                                  </span>
                                ) : null;
                              })()}
                            <span className="text-xs text-muted-foreground sm:hidden">
                              &middot;
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
