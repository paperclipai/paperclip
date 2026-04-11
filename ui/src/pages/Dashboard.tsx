import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { executiveSummaryApi } from "../api/executiveSummary";
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
import { cn, formatCents } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, CompanyKpiTrend, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

type KpiDraftRow = {
  label: string;
  value: string;
  trend: CompanyKpiTrend;
  note: string;
};

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);
  const [kpiDraftRows, setKpiDraftRows] = useState<KpiDraftRow[]>([]);

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

  const { data: executiveSummary, error: executiveSummaryError } = useQuery({
    queryKey: queryKeys.executiveSummary.detail(selectedCompanyId!),
    queryFn: () => executiveSummaryApi.getSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!executiveSummary) {
      setKpiDraftRows([]);
      return;
    }
    setKpiDraftRows(
      executiveSummary.manualKpis.map((kpi) => ({
        label: kpi.label,
        value: kpi.value,
        trend: kpi.trend,
        note: kpi.note ?? "",
      })),
    );
  }, [executiveSummary]);

  const saveKpisMutation = useMutation({
    mutationFn: async () =>
      executiveSummaryApi.replaceKpis(
        selectedCompanyId!,
        kpiDraftRows
          .map((row) => ({
            label: row.label.trim(),
            value: row.value.trim(),
            trend: row.trend,
            note: row.note.trim() || null,
          }))
          .filter((row) => row.label.length > 0 && row.value.length > 0),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.executiveSummary.detail(selectedCompanyId!) });
    },
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

  function updateKpiRow(index: number, patch: Partial<KpiDraftRow>) {
    setKpiDraftRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  }

  function removeKpiRow(index: number) {
    setKpiDraftRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }

  function addKpiRow() {
    setKpiDraftRows((current) => [...current, { label: "", value: "", trend: "none", note: "" }]);
  }

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

          <div className="rounded-lg border border-border bg-card px-4 py-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Executive Summary
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Manual KPIs plus deterministic top changes used for daily executive summary emails.
                </p>
              </div>
              {executiveSummary ? (
                <div className="text-right text-xs text-muted-foreground">
                  <div>
                    Last send: {executiveSummary.dispatch.lastSentAt ? new Date(executiveSummary.dispatch.lastSentAt).toLocaleString() : "Never"}
                  </div>
                  <div>
                    Status: {executiveSummary.dispatch.lastStatus ?? "n/a"}
                  </div>
                </div>
              ) : null}
            </div>

            {executiveSummaryError ? (
              <p className="text-xs text-destructive">
                {executiveSummaryError instanceof Error ? executiveSummaryError.message : "Failed to load executive summary"}
              </p>
            ) : null}

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Month spend</p>
                <p className="mt-1 text-sm font-medium">
                  {formatCents(executiveSummary?.computedKpis.monthSpendCents ?? 0)}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Budget utilization</p>
                <p className="mt-1 text-sm font-medium">
                  {executiveSummary?.computedKpis.monthUtilizationPercent ?? 0}%
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Tasks (open / blocked)</p>
                <p className="mt-1 text-sm font-medium">
                  {(executiveSummary?.computedKpis.tasksOpen ?? 0)} / {(executiveSummary?.computedKpis.tasksBlocked ?? 0)}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Pending approvals</p>
                <p className="mt-1 text-sm font-medium">
                  {executiveSummary?.computedKpis.pendingApprovals ?? 0}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Published KPIs</p>
                <button
                  type="button"
                  onClick={addKpiRow}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                >
                  Add KPI
                </button>
              </div>
              {kpiDraftRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No KPIs yet. Add KPI rows and publish them.</p>
              ) : (
                <div className="space-y-2">
                  {kpiDraftRows.map((row, index) => (
                    <div key={`${index}:${row.label}`} className="grid gap-2 rounded-md border border-border px-3 py-3 md:grid-cols-[1.1fr_1fr_120px_1.2fr_auto]">
                      <input
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                        placeholder="Label"
                        value={row.label}
                        onChange={(event) => updateKpiRow(index, { label: event.target.value })}
                      />
                      <input
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                        placeholder="Value"
                        value={row.value}
                        onChange={(event) => updateKpiRow(index, { value: event.target.value })}
                      />
                      <select
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                        value={row.trend}
                        onChange={(event) => updateKpiRow(index, { trend: event.target.value as CompanyKpiTrend })}
                      >
                        <option value="none">none</option>
                        <option value="up">up</option>
                        <option value="down">down</option>
                        <option value="flat">flat</option>
                      </select>
                      <input
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                        placeholder="Optional note"
                        value={row.note}
                        onChange={(event) => updateKpiRow(index, { note: event.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => removeKpiRow(index)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => saveKpisMutation.mutate()}
                  disabled={saveKpisMutation.isPending || !selectedCompanyId}
                  className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-60"
                >
                  {saveKpisMutation.isPending ? "Publishing..." : "Publish KPIs"}
                </button>
                {saveKpisMutation.isError ? (
                  <span className="text-xs text-destructive">
                    {saveKpisMutation.error instanceof Error ? saveKpisMutation.error.message : "Failed to publish KPIs"}
                  </span>
                ) : null}
                {saveKpisMutation.isSuccess ? (
                  <span className="text-xs text-muted-foreground">Published</span>
                ) : null}
              </div>
            </div>

            <div className="grid gap-2 lg:grid-cols-2">
              <div className="rounded-md border border-border px-3 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Top issue transitions (24h)</p>
                {(executiveSummary?.topChanges.issueTransitions.length ?? 0) === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No notable issue transitions.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-xs">
                    {executiveSummary?.topChanges.issueTransitions.map((entry) => (
                      <li key={`${entry.issueId}:${entry.updatedAt}`}>
                        {(entry.issueIdentifier ?? entry.issueId)} · {entry.fromStatus ?? "unknown"} → {entry.toStatus}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-md border border-border px-3 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Failed runs (24h)</p>
                {(executiveSummary?.topChanges.failedRuns.length ?? 0) === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No failed or timed-out runs.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-xs">
                    {executiveSummary?.topChanges.failedRuns.map((entry) => (
                      <li key={entry.runId}>
                        {(entry.agentName ?? entry.agentId)} · {entry.status}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
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
