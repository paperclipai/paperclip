import { Link } from "@/lib/router";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { deriveInitials } from "./Identity";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { formatActivityVerb } from "../lib/activity-format";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "../lib/company-members";

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({ event, agentMap, userProfileMap, entityNameMap, entityTitleMap, className }: ActivityRowProps) {
  const verb = formatActivityVerb(event.action, event.details, { agentMap, userProfileMap });

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  const actorName = actor?.name ?? (event.actorType === "system" ? "System" : userProfile?.label ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown"));
  const actorAvatarUrl = userProfile?.image ?? null;

  const inner = (
    <div className="space-y-2">
      <div className="flex items-start gap-2 @xl:grid @xl:grid-cols-(--dashboard-activity-list-columns) @xl:items-baseline">
        <Avatar size="sm" aria-hidden="true" className="@xl:self-center">
          {actorAvatarUrl && <AvatarImage src={actorAvatarUrl} alt="" />}
          <AvatarFallback>{deriveInitials(actorName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-1 @xl:contents">
          <div className="flex min-w-0 items-baseline gap-2 @xl:contents">
            <p className="flex h-6 min-w-0 flex-1 items-center gap-1.5">
              <span className="max-w-1/2 shrink-0 truncate" title={`${actorName} ${verb}`}>
                <span>{actorName}</span>{" "}
                <span className="text-muted-foreground">{verb}</span>
              </span>
              {event.entityType === "issue" ? (
                <span className="min-w-0 flex-1 truncate" title={entityTitle}>{entityTitle}</span>
              ) : (
                <span className="min-w-0 flex-1 truncate">
                  {name && <span className="font-medium">{name}</span>}
                  {entityTitle && <span className="text-muted-foreground"> — {entityTitle}</span>}
                </span>
              )}
            </p>
            <span className="ml-auto shrink-0 truncate text-right font-mono text-(length:--text-micro) text-muted-foreground @xl:w-(--dashboard-list-id-width)">
              {event.entityType === "issue" ? name : null}
            </span>
          </div>
          <div className="flex min-h-6 min-w-0 items-center @xl:contents">
            <span className="ml-auto w-(--dashboard-list-time-width) shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">
              {timeAgo(event.createdAt)}
            </span>
          </div>
        </div>
      </div>
      <IssueReferenceActivitySummary event={event} />
    </div>
  );

  const classes = cn(
    "dashboard-list-row text-sm",
    link && "cursor-pointer hover:bg-accent/50 transition-colors",
    className,
  );

  if (link) {
    return (
      <Link to={link} className={cn(classes, "no-underline text-inherit block")}>
        {inner}
      </Link>
    );
  }

  return (
    <div className={classes}>
      {inner}
    </div>
  );
}
