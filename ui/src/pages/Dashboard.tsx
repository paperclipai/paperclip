import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { credentialsApi } from "../api/credentials";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { CircularStatWidget } from "../components/CircularStatWidget";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { formatCents, formatTokens } from "../lib/utils";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, Eye } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { AnimatedNumber, DotMatrixText } from "../components/NothingAesthetic";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SmokeLabDashboardCard } from "../components/SmokeLabDashboardCard";
import { DashboardQuotaCard } from "../components/DashboardQuotaCard";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
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
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

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
    refetchInterval: 15_000,
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

  // "Needs you": issues genuinely awaiting THIS user's decision — the same
  // strict signal the Inbox "Needs you" tab uses (awaitingDecisionForUserId),
  // so the dashboard count matches the Inbox instead of over-counting every
  // in_review item (those may be under review by an agent, not waiting on you).
  // The metric deep-links to /inbox/decisions, which renders this exact set.
  const { data: waitingOnYou } = useQuery({
    queryKey: ["issues", selectedCompanyId, "awaiting-decision", "me"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, { awaitingDecisionForUserId: "me", includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // "In review": the broader "what's in flight on me" view — issues assigned to
  // the current user currently in_review. Distinct from "Needs you" (those
  // strictly awaiting your decision); an in_review issue may be under review by
  // an agent and not require your action yet.
  const { data: inReviewMine } = useQuery({
    queryKey: ["issues", selectedCompanyId, "in-review", "me"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeUserId: "me", status: "in_review" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const forceCredentialQuotaRefreshRef = useRef(false);
  const {
    data: credentialQuota = [],
    error: providerQuotaError,
    isFetching: providerQuotaFetching,
    isLoading: providerQuotaLoading,
    refetch: refetchProviderQuota,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.credentials.quotaWindows(selectedCompanyId)
      : ["credentials", "none", "quota-windows"],
    queryFn: () => {
      const refresh = forceCredentialQuotaRefreshRef.current;
      forceCredentialQuotaRefreshRef.current = false;
      return credentialsApi.quotaWindows(selectedCompanyId!, { refresh });
    },
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const refreshProviderQuota = () => {
    forceCredentialQuotaRefreshRef.current = true;
    void refetchProviderQuota();
  };

  const {
    data: credentialUsageResponse,
    error: credentialUsageError,
    isLoading: credentialUsageLoading,
  } = useQuery({
    queryKey: selectedCompanyId
      ? ["credentials", selectedCompanyId, "usage", "mtd"]
      : ["credentials", "none", "usage", "mtd"],
    queryFn: () => credentialsApi.usage(selectedCompanyId!, { period: "month" }),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
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
  // Stalled tasks: open issues whose blocker-attention says they're stalled or
  // need attention (computed server-side and returned on the list). Most-recent
  // first so the drill-down shows what to investigate.
  const stalledIssues = useMemo(
    () =>
      getRecentIssues(
        (issues ?? []).filter(
          (i) =>
            i.blockerAttention?.state === "stalled" ||
            i.blockerAttention?.state === "needs_attention",
        ),
      ),
    [issues],
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
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-8 pb-10">
      {error && <p className="dashboard-tone-danger text-sm">{error.message}</p>}

      {hasNoAgents && (
        <div className="dashboard-alert dashboard-alert-warning flex items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Bot className="dashboard-tone-warning h-4 w-4 shrink-0" />
            <p className="dashboard-alert-copy text-sm">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="dashboard-alert-action shrink-0 text-sm font-medium underline"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel
        companyId={selectedCompanyId!}
        headerExtra={
          data ? (
            <div className="dashboard-live-summary">
              <span className="dashboard-live-dot h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" aria-hidden />
              <span>Tokens this month</span>
              <DotMatrixText className="dashboard-live-value leading-none">
                <AnimatedNumber
                  value={
                    data.costs.monthInputTokens
                    + data.costs.monthOutputTokens
                    + data.costs.monthCachedInputTokens
                  }
                  format={formatTokens}
                />
              </DotMatrixText>
            </div>
          ) : null
        }
      />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="dashboard-alert dashboard-alert-danger flex items-start justify-between gap-3 px-5 py-4">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="dashboard-tone-danger mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="dashboard-alert-copy text-sm font-medium">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="dashboard-alert-copy text-xs opacity-75">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="dashboard-alert-action text-sm underline">
                Open budgets
              </Link>
            </div>
          ) : null}

          <DashboardQuotaCard
            results={credentialQuota}
            usage={credentialUsageResponse?.usage}
            isLoading={providerQuotaLoading}
            isFetching={providerQuotaFetching}
            usageLoading={credentialUsageLoading}
            error={
              providerQuotaError instanceof Error
                ? providerQuotaError
                : providerQuotaError
                  ? "The quota request failed."
                  : null
            }
            usageError={
              credentialUsageError instanceof Error
                ? credentialUsageError
                : credentialUsageError
                  ? "The usage request failed."
                  : null
            }
            monthTokens={
              data.costs.monthInputTokens
              + data.costs.monthCachedInputTokens
              + data.costs.monthOutputTokens
            }
            monthSpendCents={data.costs.monthSpendCents}
            onRefresh={refreshProviderQuota}
          />

          {(() => {
            const costsPercent =
              data.costs.monthBudgetCents > 0 ? data.costs.monthUtilizationPercent / 100 : 0;
            const costsTone: "default" | "danger" =
              data.costs.monthBudgetCents > 0 && data.costs.monthUtilizationPercent > 80
                ? "danger"
                : "default";
            const approvalsCount = data.pendingApprovals + data.budgets.pendingApprovals;
            const approvalsPercent = Math.min(approvalsCount / 10, 1);
            const approvalsTone: "default" | "danger" = approvalsCount > 0 ? "danger" : "default";
            // "Needs you" = issues awaiting this user's decision (same set as the
            // Inbox "Needs you" tab). "Stalled" = issues whose blockerAttention
            // says they're stalled or need attention (client-side from the issues
            // list, which carries blockerAttention).
            const waitingCount = waitingOnYou?.length ?? 0;
            const waitingTone: "default" | "danger" = waitingCount > 0 ? "danger" : "default";
            const inReviewCount = inReviewMine?.length ?? 0;
            const stalledCount = stalledIssues.length;
            const stalledTone: "default" | "danger" = stalledCount > 0 ? "danger" : "default";
            return (
              <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 sm:gap-4">
                <CircularStatWidget
                  icon={Bot}
                  value={waitingCount}
                  label="Needs you"
                  percent={Math.min(waitingCount / 10, 1)}
                  tone={waitingTone}
                  to="/inbox/decisions"
                  description={
                    <span>
                      {waitingCount > 0 ? "awaiting your decision" : "nothing waiting"}
                    </span>
                  }
                />
                <CircularStatWidget
                  icon={Eye}
                  value={inReviewCount}
                  label="In review"
                  percent={Math.min(inReviewCount / 10, 1)}
                  tone="info"
                  to="/issues"
                  description={
                    <span>
                      {inReviewCount > 0 ? "in flight, assigned to you" : "nothing in review"}
                    </span>
                  }
                />
                <CircularStatWidget
                  icon={PauseCircle}
                  value={stalledCount}
                  label="Stalled tasks"
                  percent={Math.min(stalledCount / 10, 1)}
                  tone={stalledTone}
                  to="/issues"
                  description={
                    <span>
                      {stalledCount > 0 ? "needs attention" : "none stalled"}
                    </span>
                  }
                />
                {(() => {
                  const tokensTotal =
                    data.costs.monthInputTokens
                    + data.costs.monthOutputTokens
                    + data.costs.monthCachedInputTokens;
                  const tokensLabel = formatTokens(tokensTotal);
                  const hasCost = data.costs.monthSpendCents > 0;
                  return (
                    <CircularStatWidget
                      icon={DollarSign}
                      value={hasCost ? formatCents(data.costs.monthSpendCents) : tokensLabel}
                      label={hasCost ? "Month Spend" : "Month Tokens"}
                      percent={costsPercent}
                      tone={costsTone}
                      to="/costs"
                      description={
                        <span>
                          {hasCost
                            ? (data.costs.monthBudgetCents > 0
                                ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget · ${tokensLabel} tokens`
                                : `${tokensLabel} tokens · unlimited budget`)
                            : (data.costs.monthBudgetCents > 0
                                ? `${formatCents(data.costs.monthSpendCents)} cost · ${formatCents(data.costs.monthBudgetCents)} budget`
                                : "Subscription plan — $0 metered")}
                        </span>
                      }
                    />
                  );
                })()}
                <CircularStatWidget
                  icon={ShieldCheck}
                  value={approvalsCount}
                  label="Pending Approvals"
                  percent={approvalsPercent}
                  tone={approvalsTone}
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
            );
          })()}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
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
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
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
              label="Pending Approvals"
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

          <SmokeLabDashboardCard companyId={selectedCompanyId!} />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            {/* PAP-411: "Tasks by Priority" chart hidden behind SHOW_TASK_PRIORITY_UI. */}
            {SHOW_TASK_PRIORITY_UI && (
              <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
                <PriorityChart issues={issues ?? []} />
              </ChartCard>
            )}
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
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
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="dashboard-plugin-card rounded-lg border p-4"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="dashboard-section-title mb-3 px-1">
                  Recent Activity
                </h3>
                <Card className="dashboard-list block py-0 divide-y overflow-hidden">
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

            {/* Needs you — issues awaiting your decision (same set as Inbox) */}
            {waitingOnYou && waitingOnYou.length > 0 && (
              <div className="min-w-0">
                <h3 className="dashboard-section-title mb-3 px-1">
                  <span>Needs you ({waitingOnYou.length})</span>
                  <Link to="/inbox/decisions" className="dashboard-link text-xs font-normal normal-case no-underline hover:underline">
                    Open inbox
                  </Link>
                </h3>
                <div className="dashboard-list rounded-2xl border divide-y overflow-hidden">
                  {waitingOnYou.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="dashboard-list-row px-5 py-4 text-sm cursor-pointer no-underline text-inherit"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            <span className="dashboard-chip-warning rounded px-1.5 py-0.5 text-xs font-medium shrink-0">
                              needs decision
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
              </div>
            )}

            {/* Stalled tasks — drill-down for the "Stalled tasks" metric */}
            {stalledIssues.length > 0 && (
              <div className="min-w-0">
                <h3 className="dashboard-section-title mb-3 px-1">
                  Stalled tasks ({stalledIssues.length})
                </h3>
                <div className="dashboard-list rounded-2xl border divide-y overflow-hidden">
                  {stalledIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="dashboard-list-row px-5 py-4 text-sm cursor-pointer no-underline text-inherit"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.blockerAttention?.reason && (
                              <span className="dashboard-chip-warning rounded px-1.5 py-0.5 text-xs font-medium shrink-0">
                                {issue.blockerAttention.reason.replace(/_/g, " ")}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="dashboard-section-title mb-3 px-1">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <Card className="dashboard-subtle-panel block border p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </Card>
              ) : (
                <Card className="dashboard-list block py-0 divide-y overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="dashboard-list-row px-5 py-4 text-sm cursor-pointer no-underline text-inherit"
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
