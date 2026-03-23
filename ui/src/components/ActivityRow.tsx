import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { useLanguage } from "@/context/LanguageContext";
import type { Translations } from "@/i18n/en";

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function buildActionVerbs(t: Translations): Record<string, string> {
  return {
    "issue.created": t.activity.verbCreated,
    "issue.updated": t.activity.verbUpdated,
    "issue.checked_out": t.activity.verbCheckedOut,
    "issue.released": t.activity.verbReleased,
    "issue.comment_added": t.activity.verbCommentedOn,
    "issue.attachment_added": t.activity.verbAttachedFileTo,
    "issue.attachment_removed": t.activity.verbRemovedAttachmentFrom,
    "issue.document_created": t.activity.verbCreatedDocumentFor,
    "issue.document_updated": t.activity.verbUpdatedDocumentOn,
    "issue.document_deleted": t.activity.verbDeletedDocumentFrom,
    "issue.commented": t.activity.verbCommentedOn,
    "issue.deleted": t.activity.verbDeleted,
    "agent.created": t.activity.verbCreated,
    "agent.updated": t.activity.verbUpdated,
    "agent.paused": t.activity.verbPaused,
    "agent.resumed": t.activity.verbResumed,
    "agent.terminated": t.activity.verbTerminated,
    "agent.key_created": t.activity.verbCreatedApiKeyFor,
    "agent.budget_updated": t.activity.verbUpdatedBudgetFor,
    "agent.runtime_session_reset": t.activity.verbResetSessionFor,
    "heartbeat.invoked": t.activity.verbInvokedHeartbeatFor,
    "heartbeat.cancelled": t.activity.verbCancelledHeartbeatFor,
    "approval.created": t.activity.verbRequestedApproval,
    "approval.approved": t.activity.verbApproved,
    "approval.rejected": t.activity.verbRejected,
    "project.created": t.activity.verbCreated,
    "project.updated": t.activity.verbUpdated,
    "project.deleted": t.activity.verbDeleted,
    "goal.created": t.activity.verbCreated,
    "goal.updated": t.activity.verbUpdated,
    "goal.deleted": t.activity.verbDeleted,
    "cost.reported": t.activity.verbReportedCostFor,
    "cost.recorded": t.activity.verbRecordedCostFor,
    "company.created": t.activity.verbCreatedCompany,
    "company.updated": t.activity.verbUpdatedCompany,
    "company.archived": t.activity.verbArchived,
    "company.budget_updated": t.activity.verbUpdatedBudgetFor,
  };
}

function formatVerb(action: string, details: Record<string, unknown> | null | undefined, t: Translations): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? t.activity.changedStatusFromTo.replace("{from}", humanizeValue(from)).replace("{to}", humanizeValue(details.status))
        : t.activity.changedStatusTo.replace("{to}", humanizeValue(details.status));
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? t.activity.changedPriorityFromTo.replace("{from}", humanizeValue(from)).replace("{to}", humanizeValue(details.priority))
        : t.activity.changedPriorityTo.replace("{to}", humanizeValue(details.priority));
    }
  }
  return buildActionVerbs(t)[action] ?? action.replace(/[._]/g, " ");
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
  const { t } = useLanguage();
  const verb = formatVerb(event.action, event.details, t);

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
  const actorName = actor?.name ?? (event.actorType === "system" ? t.activity.actorSystem : event.actorType === "user" ? t.activity.actorBoard : event.actorId || t.activity.actorUnknown);

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
