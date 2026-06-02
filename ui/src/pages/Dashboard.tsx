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
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { CircularStatWidget } from "../components/CircularStatWidget";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents, formatTokens } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { AnimatedNumber, DotMatrixText } from "../components/NothingAesthetic";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

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

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // "Waiting on you": issues assigned to the current user that need their
  // action — in_review (needs your review) or blocked (needs you to unblock).
  // Server resolves the literal "me" to the board user and accepts the status
  // list, so no backend change is needed.
  const { data: waitingOnYou } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), { waitingOnYou: true }],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, { assigneeUserId: "me", status: "in_review,blocked" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
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
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-300/60 bg-amber-50/80 backdrop-blur-sm px-5 py-4 dark:border-amber-500/25 dark:bg-amber-950/60 shadow-sm">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel
        companyId={selectedCompanyId!}
        headerExtra={
          data ? (
            <div className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-[#34BFF0] animate-pulse" aria-hidden />
              <span>Tokens this month</span>
              <DotMatrixText className="text-[15px] leading-none text-foreground">
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
            <div className="flex items-start justify-between gap-3 rounded-2xl border border-red-500/20 bg-[linear-gradient(135deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] backdrop-blur-sm px-5 py-4 shadow-sm">
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
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          {(() => {
            const agentsTotal =
              data.agents.active + data.agents.running + data.agents.paused + data.agents.error;
            const agentsPercent = agentsTotal > 0 ? data.agents.running / agentsTotal : 0;
            const tasksDenom = data.tasks.inProgress + data.tasks.open + data.tasks.blocked;
            const tasksPercent = tasksDenom > 0 ? data.tasks.inProgress / tasksDenom : 0;
            const costsPercent =
              data.costs.monthBudgetCents > 0 ? data.costs.monthUtilizationPercent / 100 : 0;
            const costsTone: "default" | "danger" =
              data.costs.monthBudgetCents > 0 && data.costs.monthUtilizationPercent > 80
                ? "danger"
                : "default";
            const approvalsCount = data.pendingApprovals + data.budgets.pendingApprovals;
            const approvalsPercent = Math.min(approvalsCount / 10, 1);
            const approvalsTone: "default" | "danger" = approvalsCount > 0 ? "danger" : "default";
            return (
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                <CircularStatWidget
                  icon={Bot}
                  value={agentsTotal}
                  label="Agents Enabled"
                  percent={agentsPercent}
                  tone="info"
                  to="/agents"
                  description={
                    <span>
                      {data.agents.running} running{", "}
                      {data.agents.paused} paused{", "}
                      {data.agents.error} errors
                    </span>
                  }
                />
                <CircularStatWidget
                  icon={CircleDot}
                  value={data.tasks.inProgress}
                  label="Tasks In Progress"
                  percent={tasksPercent}
                  tone="info"
                  to="/issues"
                  description={
                    <span>
                      {data.tasks.open} open{", "}
                      {data.tasks.blocked} blocked
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

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
            itemClassName="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm p-5"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                  Recent Activity
                </h3>
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
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
                </div>
              </div>
            )}

            {/* Waiting on you — issues assigned to you needing review/unblock */}
            {waitingOnYou && waitingOnYou.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                  Waiting on you ({waitingOnYou.length})
                </h3>
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {waitingOnYou.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-5 py-4 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit block"
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
                            <span className={cn(
                              "text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0",
                              issue.status === "in_review"
                                ? "bg-sky-500/10 text-sky-600"
                                : "bg-amber-500/10 text-amber-600",
                            )}>
                              {issue.status === "in_review" ? "review" : "blocked"}
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

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3 px-1">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm p-5">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : (
                <div className="rounded-2xl border border-border/60 bg-background/70 backdrop-blur-sm shadow-sm divide-y divide-border/50 overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-5 py-4 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit block"
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
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
