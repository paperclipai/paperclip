import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import {
  Newspaper,
  AlertTriangle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { Agent, ActivityEvent } from "@paperclipai/shared";

const SIGNIFICANT_ACTIONS = new Set([
  "agent.created",
  "agent.terminated",
  "agent.paused",
  "agent.hire_created",
  "agent.permissions_updated",
  "agent.budget_updated",
  "approval.created",
  "approval.approved",
  "approval.rejected",
  "approval.revision_requested",
  "company.budget_updated",
  "cost.reported",
  "goal.created",
  "goal.updated",
  "project.created",
]);

const ERROR_ACTIONS = new Set([
  "agent.terminated",
  "approval.rejected",
  "approval.requester_wakeup_failed",
]);

function groupByTimePeriod(events: ActivityEvent[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const groups: { label: string; events: ActivityEvent[] }[] = [
    { label: "Today", events: [] },
    { label: "Yesterday", events: [] },
    { label: "This Week", events: [] },
    { label: "Earlier", events: [] },
  ];

  for (const event of events) {
    const date = new Date(event.createdAt);
    if (date >= todayStart) {
      groups[0].events.push(event);
    } else if (date >= yesterdayStart) {
      groups[1].events.push(event);
    } else if (date >= weekStart) {
      groups[2].events.push(event);
    } else {
      groups[3].events.push(event);
    }
  }

  return groups.filter((g) => g.events.length > 0);
}

function getAgentSummaries(
  events: ActivityEvent[],
  agentMap: Map<string, Agent>,
) {
  const byAgent = new Map<
    string,
    { count: number; actions: Map<string, number>; lastSeen: Date }
  >();

  for (const event of events) {
    if (event.actorType !== "agent") continue;
    const id = event.actorId;
    const existing = byAgent.get(id) ?? {
      count: 0,
      actions: new Map(),
      lastSeen: new Date(0),
    };
    existing.count++;
    existing.actions.set(
      event.action,
      (existing.actions.get(event.action) ?? 0) + 1,
    );
    const date = new Date(event.createdAt);
    if (date > existing.lastSeen) existing.lastSeen = date;
    byAgent.set(id, existing);
  }

  return [...byAgent.entries()]
    .map(([agentId, summary]) => ({
      agentId,
      agent: agentMap.get(agentId),
      ...summary,
      topActions: [...summary.actions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count);
}

function actionLabel(action: string): string {
  const verb = action.split(".")[1] ?? action;
  return verb.replace(/_/g, " ");
}

export function BoardDigest() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(
    new Set(["Today", "Yesterday"]),
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Board Digest" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
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

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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
    for (const g of goals ?? []) map.set(`goal:${g.id}`, g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const todayStart = useMemo(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()),
    [],
  );

  const todayEvents = useMemo(
    () =>
      (data ?? []).filter((e) => new Date(e.createdAt) >= todayStart),
    [data, todayStart],
  );

  const significantEvents = useMemo(
    () => todayEvents.filter((e) => SIGNIFICANT_ACTIONS.has(e.action)),
    [todayEvents],
  );

  const errorEvents = useMemo(
    () => todayEvents.filter((e) => ERROR_ACTIONS.has(e.action)),
    [todayEvents],
  );

  const activeAgentsToday = useMemo(() => {
    const ids = new Set<string>();
    for (const e of todayEvents) {
      if (e.actorType === "agent") ids.add(e.actorId);
    }
    return ids.size;
  }, [todayEvents]);

  const timeGroups = useMemo(() => groupByTimePeriod(data ?? []), [data]);

  const agentSummaries = useMemo(
    () => getAgentSummaries(data ?? [], agentMap),
    [data, agentMap],
  );

  const togglePeriod = (label: string) => {
    setExpandedPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Newspaper}
        message="Select a company to view the board digest."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="border border-border p-4">
          <p className="text-2xl font-bold">{todayEvents.length}</p>
          <p className="text-xs text-muted-foreground mt-1">Events Today</p>
        </div>
        <div className="border border-border p-4">
          <p className="text-2xl font-bold">{activeAgentsToday}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Active Agents Today
          </p>
        </div>
        <div className="border border-border p-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <p className="text-2xl font-bold">{significantEvents.length}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Significant Actions
          </p>
        </div>
        <div className="border border-border p-4">
          <div className="flex items-center gap-2">
            {errorEvents.length > 0 && (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            )}
            <p
              className={`text-2xl font-bold ${errorEvents.length > 0 ? "text-destructive" : ""}`}
            >
              {errorEvents.length}
            </p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Errors / Rejections
          </p>
        </div>
      </div>

      {/* Significant events highlight */}
      {significantEvents.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Significant Activity Today
          </h3>
          <div className="border border-border divide-y divide-border">
            {significantEvents.map((event) => (
              <div
                key={event.id}
                className={
                  ERROR_ACTIONS.has(event.action)
                    ? "bg-destructive/5"
                    : undefined
                }
              >
                <ActivityRow
                  event={event}
                  agentMap={agentMap}
                  entityNameMap={entityNameMap}
                  entityTitleMap={entityTitleMap}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Timeline — takes 2/3 */}
        <div className="lg:col-span-2 space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Activity Timeline
          </h3>
          {timeGroups.length === 0 && (
            <EmptyState icon={Newspaper} message="No activity yet." />
          )}
          {timeGroups.map((group) => {
            const isExpanded = expandedPeriods.has(group.label);
            return (
              <div key={group.label}>
                <button
                  onClick={() => togglePeriod(group.label)}
                  className="flex items-center gap-2 w-full text-left py-2 hover:bg-accent/30 transition-colors px-2 -mx-2"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium">{group.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.events.length} events
                  </span>
                </button>
                {isExpanded && (
                  <div className="border border-border divide-y divide-border">
                    {group.events.map((event) => (
                      <ActivityRow
                        key={event.id}
                        event={event}
                        agentMap={agentMap}
                        entityNameMap={entityNameMap}
                        entityTitleMap={entityTitleMap}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Agent summaries — takes 1/3 */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Agent Summary
          </h3>
          {agentSummaries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No agent activity yet.
            </p>
          )}
          <div className="space-y-3">
            {agentSummaries.map((summary) => (
              <Link
                key={summary.agentId}
                to={`/agents/${summary.agentId}`}
                className="block border border-border p-3 hover:bg-accent/50 transition-colors no-underline text-inherit"
              >
                <div className="flex items-center justify-between mb-2">
                  <Identity
                    name={summary.agent?.name ?? summary.agentId.slice(0, 8)}
                    size="sm"
                  />
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(summary.lastSeen)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {summary.count} actions
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {summary.topActions.map(([action, count]) => (
                    <span
                      key={action}
                      className="inline-flex items-center text-[11px] px-1.5 py-0.5 bg-muted text-muted-foreground"
                    >
                      {actionLabel(action)} ({count})
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
