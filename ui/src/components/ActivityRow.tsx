import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";

const ACTION_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_deleted": "deleted document from",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "approval.revision_requested": "requested revision on",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "project.workspace_created": "added workspace to",
  "project.workspace_updated": "updated workspace on",
  "project.workspace_deleted": "removed workspace from",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
  // Plugin lifecycle
  "plugin.installed": "installed plugin",
  "plugin.uninstalled": "uninstalled plugin",
  "plugin.enabled": "enabled plugin",
  "plugin.disabled": "disabled plugin",
  "plugin.upgraded": "upgraded plugin",
  "plugin.config.updated": "updated plugin config for",
  // Routine lifecycle
  "routine.created": "created routine",
  "routine.updated": "updated routine",
  "routine.deleted": "deleted routine",
  "routine.trigger_created": "added trigger to routine",
  "routine.trigger_updated": "updated routine trigger",
  "routine.trigger_deleted": "removed routine trigger",
  "routine.run_triggered": "triggered routine run",
  // Linear sync events
  "issue.synced_from_linear": "synced from Linear",
  "issue.comment.synced_from_linear": "synced comment from Linear on",
  "issue.pushed_to_linear": "pushed to Linear",
  "project.synced_from_linear": "synced from Linear",
  "project.pushed_to_linear": "pushed to Linear",
  "linear.connected": "connected Linear",
  "linear.full_sync": "synced all issues from Linear",
};

/**
 * Actions that are implementation plumbing rather than user-visible lifecycle
 * events. Hidden from the activity feed to reduce noise. Callers may filter
 * using `HIDDEN_ACTIVITY_ACTIONS`; `ActivityRow` also returns `null` for them
 * as a safety net.
 */
export const HIDDEN_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
  "issue.read_marked",
  "issue.checkout_lock_adopted",
  "approval.requester_wakeup_queued",
  "approval.requester_wakeup_failed",
]);

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function formatVerb(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`
        : `changed status to ${humanizeValue(details.status)} on`;
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
        : `changed priority to ${humanizeValue(details.priority)} on`;
    }
  }
  return ACTION_VERBS[action] ?? action.replace(/[._]/g, " ");
}

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    case "plugin": return `/settings/plugins/${name ?? entityId}`;
    case "routine":
    case "routine_trigger":
    case "routine_run": return `/routines/${entityId}`;
    default: return null;
  }
}

/**
 * Resolve the display name (short identifier) for an event's target entity.
 * Prefer values denormalized on `event.details` so that newly-created entities
 * and entities outside the current page's query cache still render with full
 * context. Falls back to the caller-supplied lookup map and finally to a
 * truncated UUID.
 */
function resolveName(
  entityType: string,
  entityId: string,
  details: Record<string, unknown> | null | undefined,
  entityNameMap: Map<string, string>,
): string | null {
  const d = (details ?? {}) as Record<string, unknown>;
  const fromDetails = (): string | undefined => {
    switch (entityType) {
      case "issue":
        return (d.identifier as string) || undefined;
      case "plugin":
        return (d.pluginKey as string) || undefined;
      case "routine":
      case "routine_trigger":
      case "routine_run":
        return (d.routineTitle as string) || (d.title as string) || undefined;
      case "approval": {
        const type = typeof d.type === "string" ? d.type.replace(/_/g, " ") : undefined;
        return (d.title as string) || type || undefined;
      }
      case "project":
        return (d.name as string) || undefined;
      default:
        return undefined;
    }
  };
  return (
    fromDetails() ??
    entityNameMap.get(`${entityType}:${entityId}`) ??
    (entityId ? entityId.slice(0, 8) : null)
  );
}

function resolveTitle(
  entityType: string,
  entityId: string,
  details: Record<string, unknown> | null | undefined,
  entityTitleMap: Map<string, string> | undefined,
): string | null {
  const d = (details ?? {}) as Record<string, unknown>;
  if (entityType === "issue") {
    return (d.issueTitle as string) || entityTitleMap?.get(`issue:${entityId}`) || null;
  }
  if (entityType === "plugin") {
    // pluginKey already surfaces as the "name"; no secondary title needed.
    return null;
  }
  if (entityType === "routine" || entityType === "routine_trigger" || entityType === "routine_run") {
    // routineTitle already surfaces as the "name".
    return null;
  }
  return entityTitleMap?.get(`${entityType}:${entityId}`) ?? null;
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({ event, agentMap, entityNameMap, entityTitleMap, className }: ActivityRowProps) {
  if (HIDDEN_ACTIVITY_ACTIONS.has(event.action)) return null;

  const verb = formatVerb(event.action, event.details);

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : resolveName(event.entityType, event.entityId, event.details as Record<string, unknown> | null, entityNameMap);

  const entityTitle = isHeartbeatEvent
    ? null
    : resolveTitle(event.entityType, event.entityId, event.details as Record<string, unknown> | null, entityTitleMap);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const actorName = actor?.name ?? (event.actorType === "system" ? "System" : event.actorType === "user" ? "Board" : event.actorId || "Unknown");

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
