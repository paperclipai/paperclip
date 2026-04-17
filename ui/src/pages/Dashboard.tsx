import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
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
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, Zap } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { CapacityPanel } from "../components/CapacityPanel";
import { ActiveWorkWidget } from "../components/ActiveWorkWidget";
import { AwaitingBoardWidget } from "../components/AwaitingBoardWidget";
import { RecentActivityWidget } from "../components/RecentActivityWidget";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, AgentWorkload, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function buildAgentWorkloadFallback(
  agents: Agent[] | undefined,
  issues: Issue[] | undefined,
): AgentWorkload | null {
  if (!agents || !issues) return null;

  const operationalAgents = agents.filter(
    (agent) => !["paused", "error", "pending_approval", "terminated"].includes(agent.status),
  );
  const inProgressTasks = issues.filter((issue) => issue.status === "in_progress");
  const queuedTasks = issues.filter(
    (issue) => (issue.status === "todo" || issue.status === "backlog") && !!issue.assigneeAgentId,
  ).length;
  const now = Date.now();

  const engineers = operationalAgents.map((agent) => {
    const currentIssues = inProgressTasks.filter((issue) => issue.assigneeAgentId === agent.id);
    const earliestStart = currentIssues.reduce<Date | null>((earliest, issue) => {
      const startedAt = toDate(issue.startedAt);
      if (!startedAt) return earliest;
      return !earliest || startedAt < earliest ? startedAt : earliest;
    }, null);

    return {
      agentId: agent.id,
      name: agent.name,
      urlKey: agent.urlKey,
      status: agent.status,
      currentTasks: currentIssues.map((issue) => ({
        issueId: issue.id,
        identifier: issue.identifier ?? String(issue.issueNumber ?? issue.id),
        title: issue.title,
        startedAt: toDate(issue.startedAt)?.toISOString() ?? null,
      })),
      timeInCurrentTaskSec: earliestStart ? Math.floor((now - earliestStart.getTime()) / 1000) : null,
    };
  });

  const idleEngineers = engineers.filter((engineer) => engineer.currentTasks.length === 0).length;
  const allBusy = engineers.length > 0 && idleEngineers === 0;

  return {
    capacityStatus: !allBusy ? "GREEN" : queuedTasks > 0 ? "RED" : "YELLOW",
    idleEngineers,
    queuedTasks,
    engineers,
  };
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

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

  const totalTokens = data
    ? (data.costs.monthInputTokens ?? 0) + (data.costs.monthOutputTokens ?? 0)
    : 0;
  const agentWorkload = (data as { agentWorkload?: AgentWorkload } | undefined)?.agentWorkload
    ?? buildAgentWorkloadFallback(agents, issues);

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
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <AwaitingBoardWidget companyId={selectedCompanyId!} />

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {agentWorkload && <CapacityPanel workload={agentWorkload} />}

      <ActiveWorkWidget companyId={selectedCompanyId!} />

      <RecentActivityWidget companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
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
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

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
              icon={Zap}
              value={formatTokens(totalTokens)}
              label="Tokens This Month"
              to="/costs"
              description={
                <span>
                  {formatTokens(data.costs.monthInputTokens ?? 0)} in{", "}
                  {formatTokens(data.costs.monthOutputTokens ?? 0)} out
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

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart runs={runs ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart runs={runs ?? []} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />


        </>
      )}
    </div>
  );
}
