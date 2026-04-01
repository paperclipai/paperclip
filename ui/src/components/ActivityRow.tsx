import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { localizedPriorityLabel, localizedStatusLabel } from "../lib/displayLabels";
import { useI18n } from "../i18n";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";

const ACTION_KEYS: Record<string, string> = {
  "issue.created": "activity.actions.issue.created",
  "issue.updated": "activity.actions.issue.updated",
  "issue.checked_out": "activity.actions.issue.checkedOut",
  "issue.released": "activity.actions.issue.released",
  "issue.comment_added": "activity.actions.issue.commentAdded",
  "issue.attachment_added": "activity.actions.issue.attachmentAdded",
  "issue.attachment_removed": "activity.actions.issue.attachmentRemoved",
  "issue.document_created": "activity.actions.issue.documentCreated",
  "issue.document_updated": "activity.actions.issue.documentUpdated",
  "issue.document_deleted": "activity.actions.issue.documentDeleted",
  "issue.commented": "activity.actions.issue.commented",
  "issue.deleted": "activity.actions.issue.deleted",
  "agent.created": "activity.actions.agent.created",
  "agent.updated": "activity.actions.agent.updated",
  "agent.paused": "activity.actions.agent.paused",
  "agent.resumed": "activity.actions.agent.resumed",
  "agent.terminated": "activity.actions.agent.terminated",
  "agent.key_created": "activity.actions.agent.keyCreated",
  "agent.budget_updated": "activity.actions.agent.budgetUpdated",
  "agent.runtime_session_reset": "activity.actions.agent.runtimeSessionReset",
  "heartbeat.invoked": "activity.actions.heartbeat.invoked",
  "heartbeat.cancelled": "activity.actions.heartbeat.cancelled",
  "approval.created": "activity.actions.approval.created",
  "approval.approved": "activity.actions.approval.approved",
  "approval.rejected": "activity.actions.approval.rejected",
  "project.created": "activity.actions.project.created",
  "project.updated": "activity.actions.project.updated",
  "project.deleted": "activity.actions.project.deleted",
  "goal.created": "activity.actions.goal.created",
  "goal.updated": "activity.actions.goal.updated",
  "goal.deleted": "activity.actions.goal.deleted",
  "cost.reported": "activity.actions.cost.reported",
  "cost.recorded": "activity.actions.cost.recorded",
  "company.created": "activity.actions.company.created",
  "company.updated": "activity.actions.company.updated",
  "company.archived": "activity.actions.company.archived",
  "company.budget_updated": "activity.actions.company.budgetUpdated",
};

function humanizeValue(value: unknown, kind: "status" | "priority" | null = null): string {
  if (typeof value !== "string") return String(value ?? "none");
  if (kind === "status") return localizedStatusLabel(value);
  if (kind === "priority") return localizedPriorityLabel(value);
  return value.replace(/_/g, " ");
}

function formatVerb(
  action: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  details?: Record<string, unknown> | null,
): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? t("activity.actions.issue.changedStatusFromTo", { from: humanizeValue(from, "status"), to: humanizeValue(details.status, "status") })
        : t("activity.actions.issue.changedStatusTo", { to: humanizeValue(details.status, "status") });
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? t("activity.actions.issue.changedPriorityFromTo", { from: humanizeValue(from, "priority"), to: humanizeValue(details.priority, "priority") })
        : t("activity.actions.issue.changedPriorityTo", { to: humanizeValue(details.priority, "priority") });
    }
  }
  const key = ACTION_KEYS[action];
  return key ? t(key) : action.replace(/[._]/g, " ");
}

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
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({ event, agentMap, entityNameMap, entityTitleMap, className }: ActivityRowProps) {
  const { t } = useI18n();
  const verb = formatVerb(event.action, t, event.details);

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
  const actorName = actor?.name ?? (event.actorType === "system"
    ? t("activity.actors.system")
    : event.actorType === "user"
      ? t("activity.actors.board")
      : event.actorId || t("activity.actors.unknown"));

  const inner = (
    <div className="flex gap-3">
      <p className="flex-1 min-w-0 truncate">
        <Identity
          name={actorName}
          size="xs"
          className="align-baseline"
        />
        <span className="text-muted-foreground ml-1">{verb} </span>
        {name && <span className="font-medium">{name}</span>}
        {entityTitle && <span className="text-muted-foreground ml-1">— {entityTitle}</span>}
      </p>
      <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{timeAgo(event.createdAt)}</span>
    </div>
  );

  const classes = cn(
    "px-4 py-2 text-sm",
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
