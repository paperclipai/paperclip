import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { translatePriority, translateStatus, translateValueLabel } from "../lib/locale";

const ACTION_VERBS: Record<string, string> = {
  "issue.created": "criou",
  "issue.updated": "atualizou",
  "issue.checked_out": "assumiu",
  "issue.released": "liberou",
  "issue.comment_added": "comentou em",
  "issue.attachment_added": "anexou arquivo em",
  "issue.attachment_removed": "removeu anexo de",
  "issue.document_created": "criou documento em",
  "issue.document_updated": "atualizou documento em",
  "issue.document_deleted": "removeu documento de",
  "issue.commented": "comentou em",
  "issue.deleted": "excluiu",
  "agent.created": "criou",
  "agent.updated": "atualizou",
  "agent.paused": "pausou",
  "agent.resumed": "retomou",
  "agent.terminated": "encerrou",
  "agent.key_created": "criou chave de API para",
  "agent.budget_updated": "atualizou orçamento de",
  "agent.runtime_session_reset": "reiniciou sessão de",
  "heartbeat.invoked": "executou heartbeat de",
  "heartbeat.cancelled": "cancelou heartbeat de",
  "approval.created": "solicitou aprovação",
  "approval.approved": "aprovou",
  "approval.rejected": "rejeitou",
  "project.created": "criou",
  "project.updated": "atualizou",
  "project.deleted": "excluiu",
  "goal.created": "criou",
  "goal.updated": "atualizou",
  "goal.deleted": "excluiu",
  "cost.reported": "reportou custo para",
  "cost.recorded": "registrou custo para",
  "company.created": "criou a empresa",
  "company.updated": "atualizou a empresa",
  "company.archived": "arquivou",
  "company.budget_updated": "atualizou orçamento de",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "nenhum");
  return translateValueLabel(value);
}

function formatVerb(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? `alterou o status de ${translateStatus(String(from))} para ${translateStatus(String(details.status))} em`
        : `alterou o status para ${translateStatus(String(details.status))} em`;
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? `alterou a prioridade de ${translatePriority(String(from))} para ${translatePriority(String(details.priority))} em`
        : `alterou a prioridade para ${translatePriority(String(details.priority))} em`;
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
  const verb = formatVerb(event.action, event.details);

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
  const actorName = actor?.name ?? (event.actorType === "system" ? "Sistema" : event.actorType === "user" ? "Board" : event.actorId || "Desconhecido");

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
