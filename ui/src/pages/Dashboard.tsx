import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
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
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SmokeLabDashboardCard } from "../components/SmokeLabDashboardCard";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.dashboard") }]);
  }, [setBreadcrumbs, t]);

  const dashboardQueryKey = queryKeys.dashboard(selectedCompanyId!);
  const sharedDashboard = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data, isLoading, error, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedDashboard, data, dashboardUpdatedAt);

  const activityQueryKey = [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }] as const;
  const sharedActivity = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: `activity:limit:${DASHBOARD_ACTIVITY_LIMIT}`,
    queryKey: activityQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data: activity, dataUpdatedAt: activityUpdatedAt } = useQuery({
    queryKey: activityQueryKey,
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedActivity, activity, activityUpdatedAt);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
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
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

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
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
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

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message={t("pages.dashboard.welcome", { defaultValue: "Welcome to Paperclip. Set up your first company and agent to get started." })}
          action={t("pages.dashboard.getStarted", { defaultValue: "Get Started" })}
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message={t("pages.dashboard.createOrSelectCompany", { defaultValue: "Create or select a company to view the dashboard." })} />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              {t("pages.dashboard.noAgents", { defaultValue: "You have no agents." })}
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            {t("pages.dashboard.createOneHere", { defaultValue: "Create one here" })}
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-950 dark:text-red-50">
                    {t("pages.dashboard.activeBudgetIncidents", { defaultValue: "{{count}} active budget incident", defaultValue_other: "{{count}} active budget incidents", count: data.budgets.activeIncidents })}
                  </p>
                  <p className="text-xs text-red-900/70 dark:text-red-100/70">
                    {t("pages.dashboard.budgetImpactSummary", { defaultValue: "{{pausedAgents}} agents paused · {{pausedProjects}} projects paused · {{pendingApprovals}} pending budget approvals", pausedAgents: data.budgets.pausedAgents, pausedProjects: data.budgets.pausedProjects, pendingApprovals: data.budgets.pendingApprovals })}
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100">
                {t("pages.dashboard.openBudgets", { defaultValue: "Open budgets" })}
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label={t("pages.dashboard.metricAgentsEnabled", { defaultValue: "Agents Enabled" })}
              to="/agents"
              description={
                <span>
                  {t("pages.dashboard.agentStatusSummary", { defaultValue: "{{running}} running, {{paused}} paused, {{errors}} errors", running: data.agents.running, paused: data.agents.paused, errors: data.agents.error })}
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label={t("pages.dashboard.metricTasksInProgress", { defaultValue: "Tasks In Progress" })}
              to="/issues"
              description={
                <span>
                  {t("pages.dashboard.taskStatusSummary", { defaultValue: "{{open}} open, {{blocked}} blocked", open: data.tasks.open, blocked: data.tasks.blocked })}
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label={t("pages.dashboard.metricMonthSpend", { defaultValue: "Month Spend" })}
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? t("pages.dashboard.percentOfBudget", { defaultValue: "{{utilization}}% of {{budget}} budget", utilization: data.costs.monthUtilizationPercent, budget: formatCents(data.costs.monthBudgetCents) })
                    : t("pages.dashboard.unlimitedBudget", { defaultValue: "Unlimited budget" })}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label={t("pages.dashboard.metricPendingApprovals", { defaultValue: "Pending Approvals" })}
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? t("pages.dashboard.budgetOverridesAwaitingBoardReview", { defaultValue: "{{count}} budget overrides awaiting board review", count: data.budgets.pendingApprovals })
                    : t("pages.dashboard.awaitingBoardReview", { defaultValue: "Awaiting board review" })}
                </span>
              }
            />
          </div>

          <SmokeLabDashboardCard companyId={selectedCompanyId!} />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title={t("pages.dashboard.chartRunActivity", { defaultValue: "Run Activity" })} subtitle={t("pages.dashboard.chartLast14Days", { defaultValue: "Last 14 days" })}>
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            {/* PAP-411: "Tasks by Priority" chart hidden behind SHOW_TASK_PRIORITY_UI. */}
            {SHOW_TASK_PRIORITY_UI && (
              <ChartCard title={t("pages.dashboard.chartTasksByPriority", { defaultValue: "Tasks by Priority" })} subtitle={t("pages.dashboard.chartLast14Days", { defaultValue: "Last 14 days" })}>
                <PriorityChart issues={issues ?? []} />
              </ChartCard>
            )}
            <ChartCard title={t("pages.dashboard.chartTasksByStatus", { defaultValue: "Tasks by Status" })} subtitle={t("pages.dashboard.chartLast14Days", { defaultValue: "Last 14 days" })}>
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title={t("pages.dashboard.chartSuccessRate", { defaultValue: "Success Rate" })} subtitle={t("pages.dashboard.chartLast14Days", { defaultValue: "Last 14 days" })}>
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  {t("pages.dashboard.recentActivity", { defaultValue: "Recent Activity" })}
                </h3>
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </Card>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                {t("pages.dashboard.recentTasks", { defaultValue: "Recent Tasks" })}
              </h3>
              {recentIssues.length === 0 ? (
                <Card className="block p-4">
                  <p className="text-sm text-muted-foreground">{t("pages.dashboard.noTasksYet", { defaultValue: "No tasks yet." })}</p>
                </Card>
              ) : (
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </Card>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
