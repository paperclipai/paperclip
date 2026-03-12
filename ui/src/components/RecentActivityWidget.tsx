import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { useMemo } from "react";
import { Activity } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.status_changed": "changed status",
  "issue.assigned": "assigned",
  "issue.completed": "completed",
  "issue.commented": "commented on",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "agent.started": "started",
  "agent.stopped": "stopped",
  "heartbeat.run": "ran heartbeat",
};

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function getEntityLabel(event: ActivityEvent): string {
  const details = event.details as Record<string, unknown> | null;
  if (details?.identifier && typeof details.identifier === "string") {
    return details.identifier;
  }
  if (details?.title && typeof details.title === "string") {
    const title = details.title as string;
    return title.length > 40 ? title.slice(0, 40) + "…" : title;
  }
  return event.entityType;
}

function getActorLabel(event: ActivityEvent, agentMap: Map<string, Agent>): string {
  if (event.actorType === "system") return "System";
  if (event.actorType === "agent" && event.actorId) {
    const agent = agentMap.get(event.actorId);
    if (agent) return agent.name;
  }
  return event.actorType === "user" ? "User" : "Unknown";
}

function getStatusChangeDescription(event: ActivityEvent): string | null {
  const details = event.details as Record<string, unknown> | null;
  if (event.action === "issue.status_changed" && details?.from && details?.to) {
    return `${details.from} → ${details.to}`;
  }
  return null;
}

interface RecentActivityWidgetProps {
  companyId: string;
}

export function RecentActivityWidget({ companyId }: RecentActivityWidgetProps) {
  const { data: events } = useQuery({
    queryKey: queryKeys.activity(companyId),
    queryFn: () => activityApi.list(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const recentEvents = useMemo(() => (events ?? []).slice(0, 15), [events]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-muted-foreground">
        <Activity className="h-4 w-4" />
        <h3 className="text-sm font-semibold uppercase tracking-wide">
          Recent Activity
        </h3>
        {recentEvents.length > 0 && (
          <span className="ml-auto text-xs font-mono">{recentEvents.length}</span>
        )}
      </div>

      {recentEvents.length === 0 ? (
        <div className="border border-border rounded-md p-4 text-sm text-muted-foreground">
          No recent activity.
        </div>
      ) : (
        <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
          {recentEvents.map((event) => {
            const actor = getActorLabel(event, agentMap);
            const action = getActionLabel(event.action);
            const entity = getEntityLabel(event);
            const statusChange = getStatusChangeDescription(event);

            return (
              <div
                key={event.id}
                className="px-3 py-2.5 flex items-start gap-3 text-sm hover:bg-accent/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-foreground">{actor}</span>
                  <span className="text-muted-foreground"> {action} </span>
                  <span className="font-mono text-xs text-foreground/80">{entity}</span>
                  {statusChange && (
                    <span className="ml-1 text-xs text-muted-foreground">({statusChange})</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                  {timeAgo(event.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
