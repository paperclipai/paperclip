import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
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
import { cn, formatCents, formatTokens } from "../lib/utils";
import { Ban, Bot, Check, ChevronDown, ChevronRight, CircleDot, Clock, DollarSign, Loader2, ShieldCheck, LayoutDashboard, PauseCircle, XCircle } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/* ------------------------------------------------------------------ */
/*  Today's Agent Work                                                 */
/* ------------------------------------------------------------------ */

function extractRunSummary(run: HeartbeatRun): string {
  const result = run.resultJson;
  if (!result) return "";
  return String(result.summary ?? result.result ?? "").trim();
}

function isToday(date: Date | string): boolean {
  const d = new Date(date);
  const now = new Date();
  // Compare in UTC to avoid timezone-dependent inconsistencies.
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

interface AgentWorkRun {
  id: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "running" | "queued";
  summary: string;
  /** finishedAt for completed runs, createdAt for active runs. */
  timestamp: string;
  issueId: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface AgentWorkGroup {
  agentId: string;
  agentName: string;
  runs: AgentWorkRun[];
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  active: number;
  totalTokens: number;
  totalCostCents: number;
}

function extractUsage(run: HeartbeatRun): { input: number; output: number; costCents: number } {
  const usage = run.usageJson as Record<string, unknown> | null;
  if (!usage) return { input: 0, output: 0, costCents: 0 };
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const costCents = Number(usage.totalCostCents ?? usage.total_cost_cents ?? 0);
  return { input, output, costCents };
}

const RUN_STATUS_LABEL: Record<AgentWorkRun["status"], string> = {
  succeeded: "Completed",
  failed: "Run failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  running: "Running",
  queued: "Queued",
};

function defaultSummary(run: HeartbeatRun): string {
  if (run.status === "failed") return run.error ?? "Run failed";
  if (run.status === "cancelled") return "Cancelled by operator";
  if (run.status === "timed_out") return "Run exceeded time limit";
  if (run.status === "running") return "Currently running…";
  if (run.status === "queued") return "Waiting to start…";
  return "Completed";
}

function groupRunsByAgent(
  runs: HeartbeatRun[],
  agentMap: Map<string, Agent>,
): AgentWorkGroup[] {
  // Include finished runs from today + any currently active runs.
  const relevantRuns = runs.filter((r) => {
    if (r.status === "running" || r.status === "queued") return true;
    const ts = r.finishedAt ?? r.createdAt;
    return ts && isToday(ts);
  }).sort((a, b) => {
    // Active runs first, then by most recent.
    const aActive = a.status === "running" || a.status === "queued" ? 1 : 0;
    const bActive = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aTs = new Date(a.finishedAt ?? a.createdAt).getTime();
    const bTs = new Date(b.finishedAt ?? b.createdAt).getTime();
    return bTs - aTs;
  });

  const grouped = new Map<string, AgentWorkGroup>();

  for (const run of relevantRuns) {
    const summary = extractRunSummary(run);
    const context = run.contextSnapshot as Record<string, unknown> | null;
    const issueId = typeof context?.issueId === "string" ? context.issueId : null;
    const usage = extractUsage(run);

    let group = grouped.get(run.agentId);
    if (!group) {
      const agent = agentMap.get(run.agentId);
      group = {
        agentId: run.agentId,
        agentName: agent?.name ?? run.agentId.slice(0, 8),
        runs: [],
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        active: 0,
        totalTokens: 0,
        totalCostCents: 0,
      };
      grouped.set(run.agentId, group);
    }

    if (run.status === "succeeded") group.succeeded += 1;
    else if (run.status === "failed") group.failed += 1;
    else if (run.status === "cancelled") group.cancelled += 1;
    else if (run.status === "timed_out") group.timedOut += 1;
    else group.active += 1;

    group.totalTokens += usage.input + usage.output;
    group.totalCostCents += usage.costCents;

    group.runs.push({
      id: run.id,
      status: run.status as AgentWorkRun["status"],
      summary: summary || defaultSummary(run),
      timestamp: String(run.finishedAt ?? run.createdAt),
      issueId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: usage.costCents,
    });
  }

  return [...grouped.values()];
}

function AgentWorkCard({
  group,
  issueMap,
}: {
  group: AgentWorkGroup;
  issueMap: Map<string, Issue>;
}) {
  const [expanded, setExpanded] = useState(false);

  // Deduplicate issues touched by this agent today.
  const touchedIssues = useMemo(() => {
    const seen = new Set<string>();
    const result: Issue[] = [];
    for (const run of group.runs) {
      if (run.issueId && !seen.has(run.issueId)) {
        seen.add(run.issueId);
        const issue = issueMap.get(run.issueId);
        if (issue) result.push(issue);
      }
    }
    return result;
  }, [group.runs, issueMap]);

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Agent header */}
      <div className="flex items-center gap-2 bg-muted/30 px-4 py-2.5">
        <Identity name={group.agentName} size="sm" />
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {group.totalTokens > 0 && (
            <span>{formatTokens(group.totalTokens)} tok</span>
          )}
          {group.totalCostCents > 0 && (
            <span>{formatCents(group.totalCostCents)}</span>
          )}
          <span className="flex items-center gap-1.5 flex-wrap">
            {group.active > 0 && (
              <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                <Loader2 className="h-3 w-3 animate-spin" />{group.active} active
              </span>
            )}
            {group.succeeded > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">{group.succeeded} succeeded</span>
            )}
            {group.failed > 0 && (
              <span className="text-red-600 dark:text-red-400">{group.failed} failed</span>
            )}
            {group.timedOut > 0 && (
              <span className="text-amber-600 dark:text-amber-400">{group.timedOut} timed out</span>
            )}
            {group.cancelled > 0 && (
              <span className="text-muted-foreground">{group.cancelled} cancelled</span>
            )}
          </span>
        </span>
      </div>

      <div className="px-4 py-2.5 space-y-2">
        {/* Issues touched */}
        {touchedIssues.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mr-1">Issues</span>
            {touchedIssues.map((issue) => (
              <Link
                key={issue.id}
                to={`/issues/${issue.identifier ?? issue.id}`}
                className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs no-underline text-inherit transition-colors hover:bg-accent"
              >
                <StatusIcon status={issue.status} />
                <span className="font-mono text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                <span className="max-w-[180px] truncate">{issue.title}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Expandable runs */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
        </button>
      </div>

      {/* Expanded run list */}
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {group.runs.map((run) => {
            const issue = run.issueId ? issueMap.get(run.issueId) ?? null : null;
            const statusIcon = run.status === "succeeded"
              ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              : run.status === "failed"
                ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                : run.status === "running"
                  ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-500 animate-spin" />
                  : run.status === "queued"
                    ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    : run.status === "timed_out"
                      ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      : <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
            const textClass = run.status === "failed"
              ? "text-red-600 dark:text-red-400"
              : run.status === "running" || run.status === "queued"
                ? "text-cyan-700 dark:text-cyan-300"
                : run.status === "timed_out"
                  ? "text-amber-700 dark:text-amber-300"
                  : run.status === "cancelled"
                    ? "text-muted-foreground"
                    : "text-foreground/80";
            return (
              <Link
                key={run.id}
                to={`/agents/${group.agentId}/runs/${run.id}`}
                className="flex items-start gap-2.5 px-4 py-2 text-sm no-underline text-inherit transition-colors hover:bg-accent/50"
              >
                {statusIcon}
                <div className="min-w-0 flex-1">
                  {issue && (
                    <span className="mr-1.5 text-xs text-muted-foreground font-mono">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                  )}
                  <span className={cn("text-sm", textClass)}>
                    {run.summary.length > 120 ? `${run.summary.slice(0, 120)}…` : run.summary}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(run.timestamp)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

const AGENT_WORK_INITIAL_LIMIT = 5;

function AgentWorkSection({
  runs,
  agentMap,
  issueMap,
}: {
  runs: HeartbeatRun[];
  agentMap: Map<string, Agent>;
  issueMap: Map<string, Issue>;
}) {
  const groups = useMemo(() => groupRunsByAgent(runs, agentMap), [runs, agentMap]);
  const [showAll, setShowAll] = useState(false);

  if (groups.length === 0) return null;

  const visibleGroups = showAll ? groups : groups.slice(0, AGENT_WORK_INITIAL_LIMIT);
  const hiddenCount = groups.length - AGENT_WORK_INITIAL_LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Today&apos;s Agent Work
        </h3>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {groups.reduce((sum, g) => sum + g.runs.length, 0)} runs across {groups.length} agent{groups.length === 1 ? "" : "s"}
          </span>
          <Link to="/agent-work" className="text-muted-foreground hover:text-foreground transition-colors no-underline">
            See All &rarr;
          </Link>
        </span>
      </div>
      <div className="space-y-3">
        {visibleGroups.map((group) => (
          <AgentWorkCard key={group.agentId} group={group} issueMap={issueMap} />
        ))}
        {!showAll && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Show {hiddenCount} more agent{hiddenCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </div>
  );
}

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

  const issueMap = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const i of issues ?? []) map.set(i.id, i);
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

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

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

          <AgentWorkSection runs={runs ?? []} agentMap={agentMap} issueMap={issueMap} />

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

            {/* Recent Tasks */}
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

        </>
      )}
    </div>
  );
}
