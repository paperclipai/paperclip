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
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, ActivityEvent } from "@ironworksai/shared";

/* ─── Time Grouping ──────────────────────────────────────────── */

function getTimeGroup(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  if (date >= weekAgo) return "This Week";
  return "Older";
}

/* ─── Event Aggregation ──────────────────────────────────────── */

interface AggregatedGroup {
  key: string;
  action: string;
  actorName: string;
  count: number;
  models: string[];
  latestEvent: ActivityEvent;
  events: ActivityEvent[];
}

function aggregateEvents(
  events: ActivityEvent[],
  agentMap: Map<string, Agent>,
): (ActivityEvent | AggregatedGroup)[] {
  const result: (ActivityEvent | AggregatedGroup)[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    // Check if this is a repeating event (same action + same actor within 5 minutes)
    let j = i + 1;
    const fiveMinutes = 5 * 60 * 1000;
    const eventTime = new Date(event.createdAt).getTime();

    while (j < events.length) {
      const next = events[j];
      const nextTime = new Date(next.createdAt).getTime();
      if (
        next.action === event.action &&
        next.actorId === event.actorId &&
        Math.abs(eventTime - nextTime) < fiveMinutes
      ) {
        j++;
      } else {
        break;
      }
    }

    const groupSize = j - i;
    if (groupSize >= 3) {
      // Aggregate this group
      const groupEvents = events.slice(i, j);
      const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
      const actorName = actor?.name ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown");
      const models = new Set<string>();
      for (const e of groupEvents) {
        const details = e.details as Record<string, unknown> | null;
        const model = details?.model as string | undefined;
        if (model) models.add(model);
      }

      result.push({
        key: `agg-${event.id}`,
        action: event.action,
        actorName,
        count: groupSize,
        models: [...models],
        latestEvent: event,
        events: groupEvents,
      });
      i = j;
    } else {
      result.push(event);
      i++;
    }
  }

  return result;
}

function isAggregated(item: ActivityEvent | AggregatedGroup): item is AggregatedGroup {
  return "count" in item && "key" in item;
}

/* ─── Action Labels ──────────────────────────────────────────── */

const ACTION_LABELS: Record<string, string> = {
  "cost.reported": "cost events",
  "cost.recorded": "cost events",
  "issue.created": "issues",
  "issue.updated": "issue updates",
  "issue.comment_added": "comments",
  "agent.created": "agents",
  "project.created": "projects",
  "goal.created": "goals",
};

/* ─── Main Component ─────────────────────────────────────────── */

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState("all");
  const [expandedAgg, setExpandedAgg] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
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
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
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

  // Filter
  const filtered = useMemo(() => {
    if (!data) return null;
    return filter !== "all"
      ? data.filter((e) => e.entityType === filter)
      : data;
  }, [data, filter]);

  // Aggregate and group by time
  const groupedItems = useMemo(() => {
    if (!filtered) return null;
    const aggregated = aggregateEvents(filtered, agentMap);

    const groups = new Map<string, (ActivityEvent | AggregatedGroup)[]>();
    for (const item of aggregated) {
      const date = isAggregated(item)
        ? new Date(item.latestEvent.createdAt)
        : new Date(item.createdAt);
      const group = getTimeGroup(date);
      const existing = groups.get(group) ?? [];
      existing.push(item);
      groups.set(group, existing);
    }

    return groups;
  }, [filtered, agentMap]);

  const entityTypes = data
    ? [...new Set(data.map((e) => e.entityType))].sort()
    : [];

  const totalEvents = filtered?.length ?? 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Audit trail of every action across your company.
          </p>
          {totalEvents > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalEvents} event{totalEvents !== 1 ? "s" : ""}
            </p>
          )}
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {entityTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {totalEvents === 0 && (
        <EmptyState icon={History} message="No activity yet." />
      )}

      {groupedItems && groupedItems.size > 0 && (
        <div className="space-y-6">
          {[...groupedItems.entries()].map(([timeGroup, items]) => (
            <div key={timeGroup}>
              {/* Time group header */}
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
                {timeGroup}
              </div>

              <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                {items.map((item) =>
                  isAggregated(item) ? (
                    <div key={item.key}>
                      <button
                        onClick={() => {
                          setExpandedAgg((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.key)) next.delete(item.key);
                            else next.add(item.key);
                            return next;
                          });
                        }}
                        className="w-full px-4 py-2.5 text-sm flex items-center justify-between hover:bg-accent/30 transition-colors text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {expandedAgg.has(item.key) ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0">
                            {item.count}
                          </span>
                          <span>
                            <span className="font-medium">{item.actorName}</span>
                            <span className="text-muted-foreground ml-1">
                              logged {item.count} {ACTION_LABELS[item.action] ?? item.action.replace(/[._]/g, " ")}
                            </span>
                            {item.models.length > 0 && (
                              <span className="text-muted-foreground ml-1">
                                — {item.models.slice(0, 3).join(", ")}
                                {item.models.length > 3 ? ` +${item.models.length - 3} more` : ""}
                              </span>
                            )}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">
                          {(() => {
                            const d = new Date(item.latestEvent.createdAt);
                            return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                          })()}
                        </span>
                      </button>
                      {expandedAgg.has(item.key) && (
                        <div className="border-t border-border/50 bg-muted/10">
                          {item.events.map((event) => (
                            <ActivityRow
                              key={event.id}
                              event={event}
                              agentMap={agentMap}
                              entityNameMap={entityNameMap}
                              entityTitleMap={entityTitleMap}
                              className="pl-12"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ActivityRow
                      key={item.id}
                      event={item}
                      agentMap={agentMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
