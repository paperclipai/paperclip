import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useNavigate } from "@/lib/router";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import {
  AlertCircle,
  Pause,
  Play,
  ArrowRight,
  Loader2,
  Inbox,
  Zap,
  Moon,
  ArrowUpDown,
  DollarSign,
  AlertTriangle,
} from "lucide-react";
import type { Company, Agent, Issue, DashboardSummary, ActivityEvent } from "@paperclipai/shared";

type SortOption = "activity" | "issues" | "problems" | "name" | "cost";

function AgentStatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-green-500 animate-pulse"
      : status === "idle" || status === "active"
        ? "bg-blue-400"
        : status === "error"
          ? "bg-red-500"
          : "bg-muted-foreground/40";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

/** Global attention banner — blocked issues + errored agents across all companies. */
function AttentionBanner({
  companies,
  allAgents,
  allIssues,
}: {
  companies: Company[];
  allAgents: Map<string, Agent[]>;
  allIssues: Map<string, Issue[]>;
}) {
  const erroredAgents: { company: Company; agent: Agent }[] = [];
  const blockedIssues: { company: Company; issue: Issue }[] = [];

  for (const company of companies) {
    const agents = allAgents.get(company.id) ?? [];
    const issues = allIssues.get(company.id) ?? [];
    for (const agent of agents) {
      if (agent.status === "error") erroredAgents.push({ company, agent });
    }
    for (const issue of issues) {
      if (issue.status === "blocked") blockedIssues.push({ company, issue });
    }
  }

  if (erroredAgents.length === 0 && blockedIssues.length === 0) return null;

  return (
    <div className="border border-red-500/30 bg-red-500/5 rounded-lg px-5 py-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-red-500" />
        <span className="text-sm font-semibold text-red-500">Needs Attention</span>
      </div>
      <div className="space-y-1.5">
        {erroredAgents.map(({ company, agent }) => (
          <div key={agent.id} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
            <a
              href={`/${company.issuePrefix}/agents/${agent.urlKey}`}
              className="font-medium text-red-400 hover:underline"
            >
              {agent.name}
            </a>
            <span className="text-muted-foreground">in</span>
            <span className="font-mono text-muted-foreground">{company.issuePrefix}</span>
            <span className="text-red-400/80">— agent error</span>
          </div>
        ))}
        {blockedIssues.map(({ company, issue }) => (
          <div key={issue.id} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full bg-yellow-500 shrink-0" />
            <a
              href={`/${company.issuePrefix}/issues/${issue.identifier}`}
              className="font-mono text-yellow-400 hover:underline"
            >
              {issue.identifier}
            </a>
            <span className="truncate text-muted-foreground">{issue.title}</span>
            <span className="text-yellow-400/80 shrink-0">— blocked</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Self-contained card that fetches its own data per company. */
function CompanyCard({
  company,
  onNavigate,
}: {
  company: Company;
  onNavigate: (prefix: string) => void;
}) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(company.id),
    queryFn: () => agentsApi.list(company.id),
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(company.id),
    queryFn: () => issuesApi.list(company.id),
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(company.id), "cc"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(company.id, 4),
    refetchInterval: 5000,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(company.id),
    queryFn: () => dashboardApi.summary(company.id),
    refetchInterval: 30000,
  });

  const inboxBadge = useInboxBadge(company.id);

  const wakeMutation = useMutation({
    mutationFn: (agentId: string) =>
      agentsApi.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" }, company.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(company.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(company.id) });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.pause(agentId, company.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(company.id) });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.resume(agentId, company.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(company.id) });
    },
  });

  const activeRuns = useMemo(
    () => (liveRuns ?? []).filter((r) => r.status === "running" || r.status === "queued"),
    [liveRuns],
  );

  const runningAgentIds = useMemo(
    () => new Set(activeRuns.map((r) => r.agentId)),
    [activeRuns],
  );

  const idleAgents = agents?.filter((a) => a.status === "idle" || a.status === "active") ?? [];
  const errorAgents = agents?.filter((a) => a.status === "error") ?? [];
  const pausedAgents = agents?.filter((a) => a.status === "paused") ?? [];

  const todoCount = issues?.filter((i) => i.status === "todo").length ?? 0;
  const inProgressCount = issues?.filter((i) => i.status === "in_progress").length ?? 0;
  const blockedCount = issues?.filter((i) => i.status === "blocked").length ?? 0;
  const doneCount = issues?.filter((i) => i.status === "done").length ?? 0;
  const totalCount = issues?.length ?? 0;
  const donePercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const costDollars = dashboard ? (dashboard.costs.monthSpendCents / 100).toFixed(2) : null;

  const recentIssues = useMemo(() => {
    if (!issues) return [];
    return [...issues]
      .filter((i) => i.status !== "done" && i.status !== "cancelled")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5);
  }, [issues]);

  const hasActivity = activeRuns.length > 0;
  const inboxCount = inboxBadge.inbox;
  const failedRuns = inboxBadge.failedRuns;

  return (
    <div
      className={`group border rounded-lg bg-card transition-all hover:border-muted-foreground/40 ${
        hasActivity ? "border-green-500/40 shadow-[0_0_12px_-3px_rgba(34,197,94,0.15)]" : "border-border"
      }`}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-md text-xs font-bold ${
                hasActivity
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {company.issuePrefix}
            </div>
            <div>
              <h3 className="font-semibold text-sm">{company.name}</h3>
              {company.description && (
                <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5 max-w-[280px]">
                  {company.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Inbox badge */}
            {(inboxCount > 0 || failedRuns > 0) && (
              <a
                href={`/${company.issuePrefix}/inbox`}
                className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md transition-colors ${
                  failedRuns > 0
                    ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                <Inbox className="h-3 w-3" />
                {inboxCount}
              </a>
            )}
            {/* Cost badge */}
            {costDollars && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                {costDollars}
              </span>
            )}
            <button
              onClick={() => onNavigate(company.issuePrefix)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 opacity-0 group-hover:opacity-100"
            >
              Open
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Agent Status Bar with wake/sleep controls */}
      <div className="px-5 py-2 border-t border-border/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs">
            {activeRuns.length > 0 && (
              <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-medium">
                <Loader2 className="h-3 w-3 animate-spin" />
                {activeRuns.length} running
              </span>
            )}
            {idleAgents.length > 0 && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Play className="h-3 w-3" />
                {idleAgents.length} idle
              </span>
            )}
            {pausedAgents.length > 0 && (
              <span className="flex items-center gap-1.5 text-yellow-600 dark:text-yellow-400">
                <Pause className="h-3 w-3" />
                {pausedAgents.length} paused
              </span>
            )}
            {errorAgents.length > 0 && (
              <span className="flex items-center gap-1.5 text-red-500">
                <AlertCircle className="h-3 w-3" />
                {errorAgents.length} error
              </span>
            )}
            {(agents?.length ?? 0) === 0 && (
              <span className="text-muted-foreground/50">No agents</span>
            )}
          </div>
          {/* Quick wake/sleep buttons */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Wake all idle */}
            {idleAgents.length > 0 && (
              <button
                onClick={() => {
                  for (const agent of idleAgents) {
                    if (!runningAgentIds.has(agent.id)) {
                      wakeMutation.mutate(agent.id);
                    }
                  }
                }}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors"
                title="Wake all idle agents"
              >
                <Zap className="h-3 w-3" />
                Wake all
              </button>
            )}
            {/* Resume all paused */}
            {pausedAgents.length > 0 && (
              <button
                onClick={() => {
                  for (const agent of pausedAgents) {
                    resumeMutation.mutate(agent.id);
                  }
                }}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/20 transition-colors"
                title="Resume all paused agents"
              >
                <Play className="h-3 w-3" />
                Resume
              </button>
            )}
            {/* Pause all running */}
            {activeRuns.length > 0 && (
              <button
                onClick={() => {
                  const runningAgents = agents?.filter((a) => runningAgentIds.has(a.id)) ?? [];
                  for (const agent of runningAgents) {
                    pauseMutation.mutate(agent.id);
                  }
                }}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-accent transition-colors"
                title="Pause all running agents"
              >
                <Moon className="h-3 w-3" />
                Sleep
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Running Agents Detail — with per-agent wake/sleep */}
      {(activeRuns.length > 0 || errorAgents.length > 0) && (
        <div className="px-5 py-2 border-t border-border/50 bg-green-500/[0.03]">
          <div className="space-y-1.5">
            {activeRuns.slice(0, 3).map((run) => (
              <div key={run.id} className="flex items-center gap-2 text-xs">
                <AgentStatusDot status="running" />
                <a
                  href={`/${company.issuePrefix}/agents/${run.agentId}`}
                  className="font-medium truncate hover:underline"
                >
                  {run.agentName}
                </a>
                {run.issueId && issues && (() => {
                  const issue = issues.find((i) => i.id === run.issueId);
                  return issue ? (
                    <a
                      href={`/${company.issuePrefix}/issues/${issue.identifier}`}
                      className="text-muted-foreground truncate hover:underline"
                    >
                      on {issue.identifier}
                    </a>
                  ) : null;
                })()}
                <span className="text-muted-foreground/60 ml-auto shrink-0">
                  {run.startedAt ? timeAgo(run.startedAt) : "queued"}
                </span>
              </div>
            ))}
            {/* Show errored agents inline */}
            {errorAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-xs">
                <AgentStatusDot status="error" />
                <a
                  href={`/${company.issuePrefix}/agents/${agent.urlKey}`}
                  className="font-medium truncate text-red-400 hover:underline"
                >
                  {agent.name}
                </a>
                <span className="text-red-400/60">error</span>
                <button
                  onClick={() => wakeMutation.mutate(agent.id)}
                  className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  Retry
                </button>
              </div>
            ))}
            {activeRuns.length > 3 && (
              <div className="text-xs text-muted-foreground/60">
                +{activeRuns.length - 3} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Issue Stats */}
      <div className="px-5 py-3 border-t border-border/50">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Issues</span>
          <span className="text-xs text-muted-foreground">{donePercent}% done</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden flex">
          {doneCount > 0 && (
            <div
              className="bg-green-500 transition-all"
              style={{ width: `${(doneCount / totalCount) * 100}%` }}
            />
          )}
          {inProgressCount > 0 && (
            <div
              className="bg-blue-500 transition-all"
              style={{ width: `${(inProgressCount / totalCount) * 100}%` }}
            />
          )}
          {blockedCount > 0 && (
            <div
              className="bg-red-400 transition-all"
              style={{ width: `${(blockedCount / totalCount) * 100}%` }}
            />
          )}
        </div>
        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
            {todoCount} todo
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            {inProgressCount} active
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-400" />
            {blockedCount} blocked
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {doneCount} done
          </span>
        </div>
      </div>

      {/* Recent Issues — clickable */}
      {recentIssues.length > 0 && (
        <div className="border-t border-border/50 divide-y divide-border/50">
          {recentIssues.map((issue) => (
            <a
              key={issue.id}
              href={`/${company.issuePrefix}/issues/${issue.identifier}`}
              className="px-5 py-2 flex items-center gap-2 text-xs hover:bg-accent/50 transition-colors"
            >
              <StatusIcon status={issue.status} />
              <span className="font-mono text-muted-foreground shrink-0">
                {issue.identifier}
              </span>
              <span className="truncate">{issue.title}</span>
              <span className="text-muted-foreground/60 ml-auto shrink-0">
                {timeAgo(issue.updatedAt)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Unified activity feed across all companies. */
function ActivityFeed({ companies }: { companies: Company[] }) {
  const companyMap = useMemo(
    () => new Map(companies.map((c) => [c.id, c])),
    [companies],
  );

  const activityQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: [...queryKeys.activity(c.id), "cc"],
      queryFn: () => activityApi.list(c.id),
      refetchInterval: 15000,
    })),
  });

  const allEvents = useMemo(() => {
    const events: (ActivityEvent & { _companyId: string })[] = [];
    for (let i = 0; i < companies.length; i++) {
      const data = activityQueries[i]?.data;
      if (data) {
        for (const e of data) {
          events.push({ ...e, _companyId: companies[i]!.id });
        }
      }
    }
    return events
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 15);
  }, [companies, activityQueries]);

  if (allEvents.length === 0) return null;

  return (
    <div className="border rounded-lg bg-card">
      <div className="px-5 py-3 border-b border-border/50">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Activity</h3>
      </div>
      <div className="divide-y divide-border/50 max-h-[400px] overflow-y-auto">
        {allEvents.map((event) => {
          const company = companyMap.get(event._companyId);
          const prefix = company?.issuePrefix ?? "?";
          const details = event.details as Record<string, string> | null;
          const issueIdentifier = details?.issueIdentifier ?? details?.identifier;

          return (
            <div key={event.id} className="px-5 py-2 flex items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground shrink-0 w-8">{prefix}</span>
              <span className="text-muted-foreground shrink-0">{event.action}</span>
              {issueIdentifier ? (
                <a
                  href={`/${prefix}/issues/${issueIdentifier}`}
                  className="font-mono text-foreground hover:underline truncate"
                >
                  {issueIdentifier}
                </a>
              ) : (
                <span className="truncate text-foreground">
                  {details?.title ?? event.entityType}
                </span>
              )}
              {details?.agentName && (
                <span className="text-muted-foreground/60 truncate">by {details.agentName}</span>
              )}
              <span className="text-muted-foreground/60 ml-auto shrink-0">
                {timeAgo(event.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Aggregate stats bar across all companies. */
function AggregateStats({
  companies,
  dashboards,
}: {
  companies: Company[];
  dashboards: Map<string, DashboardSummary>;
}) {
  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
  });

  const totalAgents = stats
    ? Object.values(stats).reduce((sum, s) => sum + s.agentCount, 0)
    : 0;
  const totalIssues = stats
    ? Object.values(stats).reduce((sum, s) => sum + s.issueCount, 0)
    : 0;

  let totalRunning = 0;
  let totalSpendCents = 0;
  for (const d of dashboards.values()) {
    totalRunning += d.agents.running;
    totalSpendCents += d.costs.monthSpendCents;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1">
      <div className="px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">{companies.length}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Companies</p>
      </div>
      <div className="px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">{totalAgents}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Agents</p>
      </div>
      <div className="px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">{totalRunning}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Running</p>
      </div>
      <div className="px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">{totalIssues}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Issues</p>
      </div>
      <div className="px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">${(totalSpendCents / 100).toFixed(0)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">This Month</p>
      </div>
    </div>
  );
}

export function CommandCenter() {
  const { companies, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<SortOption>("activity");

  useEffect(() => {
    setBreadcrumbs([{ label: "Command Center" }]);
  }, [setBreadcrumbs]);

  // Fetch dashboards for all companies (for costs + running counts)
  const dashboardQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: queryKeys.dashboard(c.id),
      queryFn: () => dashboardApi.summary(c.id),
      refetchInterval: 30000,
    })),
  });

  const dashboards = useMemo(() => {
    const map = new Map<string, DashboardSummary>();
    for (let i = 0; i < companies.length; i++) {
      const d = dashboardQueries[i]?.data;
      if (d) map.set(companies[i]!.id, d);
    }
    return map;
  }, [companies, dashboardQueries]);

  // Fetch agents + issues for attention banner
  const agentQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: queryKeys.agents.list(c.id),
      queryFn: () => agentsApi.list(c.id),
    })),
  });

  const issueQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: queryKeys.issues.list(c.id),
      queryFn: () => issuesApi.list(c.id),
    })),
  });

  const allAgents = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (let i = 0; i < companies.length; i++) {
      const data = agentQueries[i]?.data;
      if (data) map.set(companies[i]!.id, data);
    }
    return map;
  }, [companies, agentQueries]);

  const allIssues = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (let i = 0; i < companies.length; i++) {
      const data = issueQueries[i]?.data;
      if (data) map.set(companies[i]!.id, data);
    }
    return map;
  }, [companies, issueQueries]);

  // Sort companies
  const sortedCompanies = useMemo(() => {
    const sorted = [...companies];
    switch (sortBy) {
      case "activity": {
        sorted.sort((a, b) => {
          const da = dashboards.get(a.id);
          const db = dashboards.get(b.id);
          return (db?.agents.running ?? 0) - (da?.agents.running ?? 0);
        });
        break;
      }
      case "issues": {
        sorted.sort((a, b) => {
          const da = dashboards.get(a.id);
          const db = dashboards.get(b.id);
          return (db?.tasks.open ?? 0) - (da?.tasks.open ?? 0);
        });
        break;
      }
      case "problems": {
        sorted.sort((a, b) => {
          const da = dashboards.get(a.id);
          const db = dashboards.get(b.id);
          const problemsA = (da?.tasks.blocked ?? 0) + (da?.agents.error ?? 0);
          const problemsB = (db?.tasks.blocked ?? 0) + (db?.agents.error ?? 0);
          return problemsB - problemsA;
        });
        break;
      }
      case "cost": {
        sorted.sort((a, b) => {
          const da = dashboards.get(a.id);
          const db = dashboards.get(b.id);
          return (db?.costs.monthSpendCents ?? 0) - (da?.costs.monthSpendCents ?? 0);
        });
        break;
      }
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return sorted;
  }, [companies, sortBy, dashboards]);

  const handleNavigate = useCallback(
    (prefix: string) => {
      const company = companies.find((c) => c.issuePrefix === prefix);
      if (company) {
        setSelectedCompanyId(company.id);
        navigate(`/${prefix}/dashboard`);
      }
    },
    [companies, setSelectedCompanyId, navigate],
  );

  return (
    <div className="space-y-6">
      <AggregateStats companies={companies} dashboards={dashboards} />

      <AttentionBanner companies={companies} allAgents={allAgents} allIssues={allIssues} />

      {/* Sort controls */}
      <div className="flex items-center gap-2">
        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Sort:</span>
        {(["activity", "problems", "issues", "cost", "name"] as SortOption[]).map((opt) => (
          <button
            key={opt}
            onClick={() => setSortBy(opt)}
            className={`text-xs px-2 py-1 rounded-md transition-colors ${
              sortBy === opt
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            {opt === "activity" ? "Activity" : opt === "problems" ? "Problems" : opt === "issues" ? "Issues" : opt === "cost" ? "Cost" : "Name"}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sortedCompanies.map((company) => (
          <CompanyCard
            key={company.id}
            company={company}
            onNavigate={handleNavigate}
          />
        ))}
      </div>

      <ActivityFeed companies={companies} />
    </div>
  );
}
