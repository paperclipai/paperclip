import { Link } from "@/lib/router";
import { t, useTranslation } from "@/i18n";
import { AgentIcon } from "./AgentIconPicker";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import {
  FileText,
  UserPlus,
  Loader2,
  Package,
  User,
  Settings,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  PencilLine,
  PauseCircle,
  PlayCircle,
  MessageCircle,
  LogIn,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Canonical verb table — one verb per action, used on every card.    */
/* ------------------------------------------------------------------ */

type VerbContext = "pinned" | "chronological";

function humanize(value: unknown): string {
  return typeof value === "string" ? value.replace(/_/g, " ") : String(value ?? "");
}

/** One verb per action. Pinned context (Tier 0) swaps a couple of verbs to
 *  emphasize that user action is needed. */
function formatVerb(
  action: string,
  details: Record<string, unknown> | null | undefined,
  context: VerbContext = "chronological",
): string {
  switch (action) {
    case "issue.created":
      return t("components.feedCard.verbOpened", { defaultValue: "opened" });
    case "issue.updated": {
      const status = details?.status;
      if (typeof status === "string")
        return t("components.feedCard.verbMovedTo", {
          status: humanize(status),
          defaultValue: "moved to {{status}}",
        });
      const priority = details?.priority;
      if (typeof priority === "string")
        return t("components.feedCard.verbSetPriorityTo", {
          priority: humanize(priority),
          defaultValue: "set priority to {{priority}} on",
        });
      return t("components.feedCard.verbUpdated", { defaultValue: "updated" });
    }
    case "issue.document_created":
      return t("components.feedCard.verbWroteDocOn", { defaultValue: "wrote doc on" });
    case "issue.document_updated":
      return t("components.feedCard.verbEditedDocOn", { defaultValue: "edited doc on" });
    case "issue.document_deleted":
      return t("components.feedCard.verbDeletedDocFrom", { defaultValue: "deleted doc from" });
    case "issue.work_product_created":
      return t("components.feedCard.verbDeliveredWorkOn", { defaultValue: "delivered work on" });
    case "issue.work_product_updated":
      return t("components.feedCard.verbUpdatedWorkOn", { defaultValue: "updated work on" });
    case "issue.work_product_deleted":
      return t("components.feedCard.verbRemovedWorkFrom", { defaultValue: "removed work from" });
    case "issue.checked_out":
      return t("components.feedCard.verbPickedUp", { defaultValue: "picked up" });
    case "issue.released":
      return t("components.feedCard.verbReleased", { defaultValue: "released" });
    case "issue.commented":
    case "issue.comment_added":
      return t("components.feedCard.verbCommentedOn", { defaultValue: "commented on" });
    case "issue.attachment_added":
      return t("components.feedCard.verbAttachedFileTo", { defaultValue: "attached a file to" });
    case "issue.attachment_removed":
      return t("components.feedCard.verbRemovedAttachmentFrom", {
        defaultValue: "removed attachment from",
      });
    case "issue.deleted":
      return t("components.feedCard.verbDeleted", { defaultValue: "deleted" });

    case "approval.created":
      return context === "pinned"
        ? t("components.feedCard.verbNeedsApprovalOn", { defaultValue: "needs approval on" })
        : t("components.feedCard.verbRequestedApprovalOn", {
            defaultValue: "requested approval on",
          });
    case "approval.approved":
      return t("components.feedCard.verbApproved", { defaultValue: "approved" });
    case "approval.rejected":
      return t("components.feedCard.verbRejected", { defaultValue: "rejected" });
    case "approval.revision_requested":
      return t("components.feedCard.verbRequestedChangesOn", {
        defaultValue: "requested changes on",
      });

    case "agent.created":
      return context === "pinned"
        ? t("components.feedCard.verbWantsToHire", { defaultValue: "wants to hire" })
        : t("components.feedCard.verbHired", { defaultValue: "hired" });
    case "agent.paused":
      return t("components.feedCard.verbPaused", { defaultValue: "paused" });
    case "agent.resumed":
      return t("components.feedCard.verbResumed", { defaultValue: "resumed" });
    case "agent.updated":
      return t("components.feedCard.verbUpdated", { defaultValue: "updated" });
    case "agent.terminated":
      return t("components.feedCard.verbTerminated", { defaultValue: "terminated" });

    case "heartbeat.invoked":
      return t("components.feedCard.verbStartedRunOn", { defaultValue: "started a run on" });
    case "heartbeat.cancelled":
      return t("components.feedCard.verbCancelledRunOn", { defaultValue: "cancelled a run on" });

    case "project.created":
      return t("components.feedCard.verbCreatedProject", { defaultValue: "created project" });
    case "project.updated":
      return t("components.feedCard.verbUpdatedProject", { defaultValue: "updated project" });
    case "project.deleted":
      return t("components.feedCard.verbDeletedProject", { defaultValue: "deleted project" });
    case "goal.created":
      return t("components.feedCard.verbCreatedGoal", { defaultValue: "created goal" });
    case "goal.updated":
      return t("components.feedCard.verbUpdatedGoal", { defaultValue: "updated goal" });
    case "goal.deleted":
      return t("components.feedCard.verbDeletedGoal", { defaultValue: "deleted goal" });
    case "company.created":
      return t("components.feedCard.verbCreatedCompany", { defaultValue: "created company" });
    case "company.updated":
      return t("components.feedCard.verbUpdatedCompany", { defaultValue: "updated company" });
    case "company.archived":
      return t("components.feedCard.verbArchivedCompany", { defaultValue: "archived company" });
    case "company.budget_updated":
      return t("components.feedCard.verbUpdatedCompanyBudget", {
        defaultValue: "updated company budget",
      });

    default:
      return action.replace(/[._]/g, " ");
  }
}

/* ------------------------------------------------------------------ */
/*  Event-time task status (for issue events without a lifecycle wrap) */
/* ------------------------------------------------------------------ */

function deriveTaskStatus(
  action: string,
  details: Record<string, unknown> | null | undefined,
): string | null {
  switch (action) {
    case "issue.created":
      return "todo";
    case "issue.updated": {
      const status = details?.status;
      return typeof status === "string" ? status : null;
    }
    case "issue.document_created":
    case "issue.document_updated":
      return "in_progress";
    case "issue.work_product_created":
      return "in_review";
    case "approval.created":
      return "in_review";
    case "approval.approved":
      return "done";
    case "approval.rejected":
    case "approval.revision_requested":
      return "blocked";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Leading icon — carries entity type AND state via color/shape.      */
/* ------------------------------------------------------------------ */

type IconSpec =
  | { kind: "lucide"; Icon: LucideIcon; color: string; filled?: boolean; spin?: boolean }
  | { kind: "status-circle"; status: string };

function getIconSpec(
  event: ActivityEvent,
  details: Record<string, unknown> | null | undefined,
  isActive: boolean,
): IconSpec {
  const action = event.action;

  // Heartbeat — animated when active, static otherwise
  if (action.startsWith("heartbeat.")) {
    if (isActive && action === "heartbeat.invoked") {
      return { kind: "lucide", Icon: Loader2, color: "text-cyan-600 dark:text-cyan-400", spin: true };
    }
    return { kind: "lucide", Icon: Loader2, color: "text-muted-foreground" };
  }

  // Approval — distinct from task status icons (those still use StatusCircle).
  // Rendered unfilled so the stroke glyph (check / alert / slash) stays visible.
  switch (action) {
    case "approval.created":
      return { kind: "lucide", Icon: CircleAlert, color: "text-amber-600 dark:text-amber-400" };
    case "approval.approved":
      return { kind: "lucide", Icon: CircleCheck, color: "text-green-600 dark:text-green-400" };
    case "approval.rejected":
      return { kind: "lucide", Icon: CircleSlash, color: "text-red-600 dark:text-red-400" };
    case "approval.revision_requested":
      return { kind: "lucide", Icon: PencilLine, color: "text-amber-600 dark:text-amber-400", filled: true };
  }

  // Agent
  switch (action) {
    case "agent.created":
      return { kind: "lucide", Icon: UserPlus, color: "text-purple-600 dark:text-purple-400" };
    case "agent.paused":
      return { kind: "lucide", Icon: PauseCircle, color: "text-muted-foreground" };
    case "agent.resumed":
      return { kind: "lucide", Icon: PlayCircle, color: "text-muted-foreground" };
    case "agent.updated":
    case "agent.terminated":
      return { kind: "lucide", Icon: Settings, color: "text-muted-foreground" };
  }

  // Document on issue
  if (action === "issue.document_created" || action === "issue.document_updated") {
    return { kind: "lucide", Icon: FileText, color: "text-blue-600 dark:text-blue-400" };
  }

  // Work product / artifact on issue
  if (action.startsWith("issue.work_product_")) {
    return { kind: "lucide", Icon: Package, color: "text-indigo-600 dark:text-indigo-400" };
  }

  // Comments
  if (action === "issue.commented" || action === "issue.comment_added") {
    return { kind: "lucide", Icon: MessageCircle, color: "text-muted-foreground" };
  }

  // Issue check-out
  if (action === "issue.checked_out") {
    return { kind: "lucide", Icon: LogIn, color: "text-muted-foreground" };
  }

  // Generic issue lifecycle → StatusCircle with event-derived status
  if (event.entityType === "issue") {
    const status = deriveTaskStatus(action, details) ?? "backlog";
    return { kind: "status-circle", status };
  }

  if (event.entityType === "goal") {
    return { kind: "lucide", Icon: Target, color: "text-muted-foreground" };
  }

  return { kind: "lucide", Icon: Settings, color: "text-muted-foreground" };
}

function StatusCircle({ status }: { status: string }) {
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  const isFilled = status === "done";
  return (
    <span className={cn("relative inline-flex h-4 w-4 shrink-0 rounded-full border-2", colorClass)}>
      {isFilled && <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />}
    </span>
  );
}

function EntityIcon({ spec }: { spec: IconSpec }) {
  if (spec.kind === "status-circle") {
    return <StatusCircle status={spec.status} />;
  }
  const { Icon, color, filled, spin } = spec;
  return (
    <Icon
      className={cn("h-4 w-4 shrink-0", color, spin && "animate-spin")}
      fill={filled ? "currentColor" : "none"}
      strokeWidth={filled ? 1.5 : 2}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Content resolution — identifier (mono) + title                     */
/* ------------------------------------------------------------------ */

interface CardContent {
  actorName: string;
  actorType: ActivityEvent["actorType"];
  actor: Agent | null;
  identifier: string | null;
  /** When true, render identifier in JetBrains Mono. Reserved for task
   *  slugs (e.g. FOA-2) and agent names. */
  identifierMono: boolean;
  title: string | null;
  link: string | null;
}

function resolveContent(
  event: ActivityEvent,
  agentMap: Map<string, Agent>,
  entityNameMap: Map<string, string>,
  entityTitleMap: Map<string, string> | undefined,
): CardContent {
  const details = event.details as Record<string, unknown> | null;
  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) ?? null : null;
  const actorName =
    actor?.name ??
    (event.actorType === "system"
      ? t("components.feedCard.actorSystem", { defaultValue: "System" })
      : event.actorType === "user"
        ? t("components.feedCard.actorBoard", { defaultValue: "Board" })
        : event.actorId || t("components.feedCard.actorUnknown", { defaultValue: "Unknown" }));

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`) ?? null;

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (details?.agentId as string | undefined)
    : undefined;
  const entityName = isHeartbeatEvent
    ? heartbeatAgentId
      ? entityNameMap.get(`agent:${heartbeatAgentId}`) ?? null
      : null
    : entityNameMap.get(`${event.entityType}:${event.entityId}`) ?? null;

  const docKey = details?.key as string | undefined;
  const isDocEvent =
    event.action === "issue.document_created" || event.action === "issue.document_updated";
  const issueSlug = entityName ?? event.entityId;
  const hiredAgentId = details?.hiredAgentId as string | undefined;
  const approvalAgentId = details?.requestedByAgentId as string | undefined;
  const approvalAgentName = approvalAgentId ? agentMap.get(approvalAgentId)?.name ?? null : null;
  const approvalType = details?.type as string | undefined;

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : event.entityType === "issue"
      ? isDocEvent && docKey
        ? `/issues/${issueSlug}#document-${encodeURIComponent(docKey)}`
        : `/issues/${issueSlug}`
      : event.entityType === "agent"
        ? `/agents/${event.entityId}`
        : event.entityType === "approval"
          ? event.action === "approval.approved" && hiredAgentId
            ? `/agents/${hiredAgentId}`
            : `/approvals/${event.entityId}`
          : event.entityType === "project"
            ? `/projects/${deriveProjectUrlKey(entityName, event.entityId)}`
            : event.entityType === "goal"
              ? `/goals/${event.entityId}`
              : null;

  let identifier: string | null = null;
  let identifierMono = true;
  let title: string | null = null;

  if (event.entityType === "issue") {
    // Docs (e.g. FOA-2#hiring-plan) previously showed the doc key, but it
    // duplicates the human-readable title that follows. Show just the task
    // slug; the title carries the document name.
    identifier = entityName;
    title = entityTitle;
  } else if (event.entityType === "approval") {
    if (approvalAgentName) {
      identifier = approvalAgentName;
    } else {
      identifier = approvalType
        ? humanize(approvalType)
        : t("components.feedCard.approvalFallback", { defaultValue: "approval" });
      identifierMono = false;
    }
    title = entityTitle;
  } else if (event.entityType === "agent") {
    identifier = (details?.name as string | undefined) ?? entityName ?? event.entityId;
    title = null;
  } else if (isHeartbeatEvent) {
    identifier = entityName;
    title = null;
  } else {
    identifier = entityName;
    title = entityTitle;
  }

  return {
    actorName,
    actorType: event.actorType,
    actor,
    identifier,
    identifierMono,
    title,
    link,
  };
}

function ActorGlyph({ content }: { content: CardContent }) {
  if (content.actorType === "agent") {
    return (
      <AgentIcon
        icon={content.actor?.icon ?? null}
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
    );
  }
  if (content.actorType === "user") {
    return <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface FeedCardProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  /** Retained for call-site compatibility; no longer read — the collapsed
   *  card always shows the event-derived status. Lifecycle aggregation (a
   *  later pass) will pass the live status through its own wrapper. */
  entityStatusMap?: Map<string, string>;
  isActive?: boolean;
  /** Tier 2 treatment: mutes the verb and title text. Actor name and
   *  timestamp retain their color; leading icon retains its color. */
  isMuted?: boolean;
  /** Tier 0 treatment: adds a trailing "Review →" affordance and swaps in
   *  pinned-context verb phrasing ("needs approval on", "wants to hire"). */
  isPinned?: boolean;
  className?: string;
}

export function FeedCard({
  event,
  agentMap,
  entityNameMap,
  entityTitleMap,
  isActive = false,
  isMuted = false,
  isPinned = false,
  className,
}: FeedCardProps) {
  const { t } = useTranslation();
  const details = event.details as Record<string, unknown> | null;
  const content = resolveContent(event, agentMap, entityNameMap, entityTitleMap);
  const verb = formatVerb(event.action, details, isPinned ? "pinned" : "chronological");
  const iconSpec = getIconSpec(event, details, isActive);

  const mutedTextBase = isMuted ? "text-muted-foreground/70" : "text-[#959596]";
  const mutedTextHover = isMuted ? "" : "group-hover:text-white";

  const card = (
    <div
      data-fc="card"
      className={cn(
        "group ml-3 mr-3 md:ml-0 my-2 flex items-center gap-2 rounded-lg border bg-card p-[18px] text-xs",
        "transition-[background-color,border-color] duration-150",
        content.link && "cursor-pointer hover:bg-accent hover:border-muted-foreground/30",
        className,
      )}
    >
      <EntityIcon spec={iconSpec} />
      <ActorGlyph content={content} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate">
        <span data-fc="actor" className={cn("font-medium", mutedTextBase, mutedTextHover)}>
          {content.actorName}
        </span>
        <span data-fc="verb" className={mutedTextBase}>{verb}</span>
        {content.identifier && (
          <span
            data-fc="id"
            className={cn(content.identifierMono && "font-mono", mutedTextBase, mutedTextHover)}
          >
            {content.identifier}
          </span>
        )}
        {content.title && (
          <span
            data-fc="title"
            className={cn("truncate", mutedTextBase, mutedTextHover)}
          >
            {content.title}
          </span>
        )}
      </span>
      {isPinned && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("components.feedCard.review", { defaultValue: "Review →" })}
        </span>
      )}
      <span data-fc="time" className="shrink-0 text-muted-foreground">
        {timeAgo(event.createdAt)}
      </span>
    </div>
  );

  if (content.link) {
    return (
      <Link
        to={content.link}
        className="block no-underline text-inherit"
        issueQuicklookSide="left"
      >
        {card}
      </Link>
    );
  }
  return card;
}
