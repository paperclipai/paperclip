import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { AgentFlowDiagram } from "../components/AgentFlowDiagram";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents, relativeTime } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, AlertTriangle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import type { OpenclawCronJob } from "../api/heartbeats";
import { PluginSlotOutlet } from "@/plugins/slots";
import { ContentPipelineWidget } from "../components/ContentPipelineWidget";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// ---- agent heartbeat status ------------------------------------------------

type AgentHeartbeatStatus = "green" | "amber" | "red" | "gray";

function agentHeartbeatStatus(agent: Agent, nowMs: number): AgentHeartbeatStatus {
  if (!agent.lastHeartbeatAt) return "gray";
  const diffMs = nowMs - new Date(agent.lastHeartbeatAt).getTime();
  if (diffMs < 60 * 60 * 1000) return "green";
  if (diffMs < 3 * 60 * 60 * 1000) return "amber";
  return "red";
}

const STATUS_DOT: Record<AgentHeartbeatStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
  gray: "bg-muted-foreground/40",
};

// ---- compact agent status row ----------------------------------------------

function AgentStatusRow({ agents }: { agents: Agent[] }) {
  const nowMs = Date.now();
  if (agents.length === 0) return null;

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agent Status
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
        {agents.map((agent) => {
          const hb = agentHeartbeatStatus(agent, nowMs);
          const lastSeen = agent.lastHeartbeatAt
            ? relativeTime(new Date(agent.lastHeartbeatAt).toISOString())
            : "never";
          return (
            <Link
              key={agent.id}
              to={`/agents/${agent.urlKey}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm no-underline hover:bg-accent/40 transition-colors"
            >
              <span className={cn("h-2 w-2 rounded-full shrink-0", STATUS_DOT[hb])} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{agent.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">{lastSeen}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ---- compact cron health card ----------------------------------------------

function ragForCronJob(job: OpenclawCronJob): { dot: string; label: string } {
  if (!job.enabled) return { dot: "bg-muted-foreground/40", label: "off" };
  if (job.consecutiveErrors >= 2 || job.lastRunStatus === "error" || job.lastRunStatus === "failed") {
    return { dot: "bg-rose-500", label: "error" };
  }
  if (!job.nextRunAtMs && !job.lastRunAtMs) return { dot: "bg-amber-500", label: "pending" };
  if (job.nextRunAtMs && job.nextRunAtMs < Date.now() - 10 * 60_000) {
    return { dot: "bg-amber-500", label: "overdue" };
  }
  return { dot: "bg-emerald-500", label: "ok" };
}

function formatNextRun(nextRunAtMs: number | null): string {
  if (!nextRunAtMs) return "—";
  const diffMs = nextRunAtMs - Date.now();
  if (diffMs < 0) return "overdue";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 2) return "soon";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `in ${hrs}h`;
}

function CronHealthCard({ jobs }: { jobs: OpenclawCronJob[] }) {
  const enabled = jobs.filter((j) => j.enabled);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          System Health
        </h3>
        <Link
          to="/ops-health"
          className="text-[11px] text-muted-foreground hover:text-foreground no-underline transition-colors"
        >
          View all →
        </Link>
      </div>
      {enabled.length === 0 ? (
        <p className="text-xs text-muted-foreground">No cron jobs configured.</p>
      ) : (
        <div className="space-y-1.5">
          {enabled.slice(0, 8).map((job) => {
            const rag = ragForCronJob(job);
            return (
              <div key={job.id} className="flex items-center gap-2 text-xs">
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", rag.dot)} />
                <span className="flex-1 truncate text-foreground/80">{job.name}</span>
                <span className="text-muted-foreground shrink-0">{formatNextRun(job.nextRunAtMs)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- needs attention card --------------------------------------------------

function NeedsAttentionCard({
  pendingApprovals,
  redAgents,
}: {
  pendingApprovals: number;
  redAgents: Agent[];
}) {
  const hasIssues = pendingApprovals > 0 || redAgents.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Needs Attention
        </h3>
      </div>
      {!hasIssues ? (
        <p className="text-xs text-muted-foreground">All clear.</p>
      ) : (
        <div className="space-y-2">
          {pendingApprovals > 0 && (
            <Link
              to="/approvals/pending"
              className="flex items-center justify-between rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs no-underline hover:bg-yellow-500/15 transition-colors"
            >
              <span className="text-yellow-300 font-medium">
                {pendingApprovals} pending approval{pendingApprovals !== 1 ? "s" : ""}
              </span>
              <span className="text-yellow-400/70">→</span>
            </Link>
          )}
          {redAgents.map((agent) => (
            <Link
              key={agent.id}
              to={`/agents/${agent.urlKey}`}
              className="flex items-center justify-between rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs no-underline hover:bg-rose-500/15 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
                <span className="text-rose-300 font-medium">{agent.name}</span>
              </div>
              <span className="text-rose-400/70 text-[10px]">no heartbeat</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- main component --------------------------------------------------------

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
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

  const { data: cronJobs } = useQuery({
    queryKey: ["instance", "openclaw-cron-jobs"],
    queryFn: () => heartbeatsApi.listOpenclawCronJobs(),
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  const nowMs = Date.now();
  const redAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (a) => a.status !== "terminated" && agentHeartbeatStatus(a, nowMs) === "red",
      ),
    [agents, nowMs],
  );

  const pendingApprovalsCount = useMemo(
    () =>
      (approvals ?? []).filter((a) => a.status === "pending" || a.status === "revision_requested")
        .length,
    [approvals],
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
  const activeAgents = (agents ?? []).filter((a) => a.status !== "terminated");

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

      {/* Agent status row */}
      {activeAgents.length > 0 && <AgentStatusRow agents={activeAgents} />}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {selectedCompanyId && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <ContentPipelineWidget companyId={selectedCompanyId} />
        </div>
      )}

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

          {/* Command Centre: two-column layout */}
          <div className="grid md:grid-cols-[1fr_300px] gap-4">
            {/* Left: flow diagram + activity + tasks */}
            <div className="space-y-4 min-w-0">
              <AgentFlowDiagram agents={activeAgents} />

              {recentActivity.length > 0 && (
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Recent Activity
                  </h3>
                  <div className="border border-border divide-y divide-border overflow-hidden">
                    {recentActivity.map((event) => (
                      <ActivityRow
                        key={event.id}
                        event={event}
                        agentMap={agentMap}
                        entityNameMap={entityNameMap}
                        entityTitleMap={entityTitleMap}
                        className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Tasks
                </h3>
                {recentIssues.length === 0 ? (
                  <div className="border border-border p-4">
                    <p className="text-sm text-muted-foreground">No tasks yet.</p>
                  </div>
                ) : (
                  <div className="border border-border divide-y divide-border overflow-hidden">
                    {recentIssues.slice(0, 10).map((issue) => (
                      <Link
                        key={issue.id}
                        to={`/issues/${issue.identifier ?? issue.id}`}
                        className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                      >
                        <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                          <span className="shrink-0 sm:hidden">
                            <StatusIcon status={issue.status} />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                            <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                              {issue.title}
                            </span>
                            <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                              <span className="hidden sm:inline-flex"><PriorityIcon priority={issue.priority} /></span>
                              <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
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

            {/* Right: system health + needs attention */}
            <div className="space-y-4">
              <CronHealthCard jobs={cronJobs ?? []} />
              <NeedsAttentionCard
                pendingApprovals={pendingApprovalsCount}
                redAgents={redAgents}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
