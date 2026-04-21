import { useMemo, useState, type MouseEvent } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Calendar, Link2, Plus } from "lucide-react";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { IssueDueBadge } from "./IssueDueBadge";
import { IssueAssigneeIcon } from "./IssueAssigneeIcon";
import { LabelPills } from "./LabelPills";
import { Button } from "@/components/ui/button";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { isIssueAssignedToCurrentActor } from "../lib/assignees";
import { formatLocalDateOnly } from "../lib/issue-due-date";
import { cn } from "../lib/utils";
import type { Issue, Project } from "@paperclipai/shared";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveKanbanReorderTarget(
  issues: Issue[],
  issueId: string,
  overId: string,
): { status: string; beforeIssueId: string | null } | null {
  const issue = issues.find((candidate) => candidate.id === issueId);
  if (!issue) return null;

  let targetStatus: string | null = null;
  if (boardStatuses.includes(overId)) {
    targetStatus = overId;
  } else {
    targetStatus = issues.find((candidate) => candidate.id === overId)?.status ?? null;
  }
  if (!targetStatus) return null;

  const targetColumnIssues = issues.filter((candidate) => candidate.status === targetStatus);
  if (boardStatuses.includes(overId)) {
    if (targetStatus === issue.status && targetColumnIssues.at(-1)?.id === issueId) return null;
    return { status: targetStatus, beforeIssueId: null };
  }

  if (targetStatus === issue.status) {
    const ids = targetColumnIssues.map((candidate) => candidate.id);
    const oldIndex = ids.indexOf(issueId);
    const overIndex = ids.indexOf(overId);
    if (oldIndex === -1 || overIndex === -1 || oldIndex === overIndex) return null;
    const nextIds = arrayMove(ids, oldIndex, overIndex);
    const nextIndex = nextIds.indexOf(issueId);
    return { status: targetStatus, beforeIssueId: nextIds[nextIndex + 1] ?? null };
  }

  const beforeIssueId = targetColumnIssues.some((candidate) => candidate.id === overId) ? overId : null;
  return { status: targetStatus, beforeIssueId };
}

interface Agent {
  id: string;
  name: string;
  icon?: string | null;
}

type KanbanProject = Pick<Project, "id" | "name"> & Partial<Pick<Project, "code" | "color">>;

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  projects?: KanbanProject[];
  liveIssueIds?: Set<string>;
  currentUserId?: string | null;
  issueLinkState?: unknown;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onReorderIssue?: (id: string, data: { status: string; beforeIssueId?: string | null }) => void;
  onAddIssue?: (status: string) => void;
}

const terminalIssueStatuses = new Set(["done", "cancelled"]);

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  projectsById,
  liveIssueIds,
  currentUserId,
  currentActorAgentIds,
  issueLinkState,
  onUpdateIssue,
  onAddIssue,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  projectsById?: ReadonlyMap<string, KanbanProject>;
  liveIssueIds?: Set<string>;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  issueLinkState?: unknown;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onAddIssue?: (status: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const isEmpty = issues.length === 0;
  const isExpanded = !isEmpty || isOver;
  const columnWidthClass = isExpanded ? "min-w-[260px] w-[260px]" : "min-w-[132px] w-[132px]";
  const addTitle = `Add task to ${statusLabel(status)}`;

  function handleAddIssue(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    onAddIssue?.(status);
  }

  function handleColumnBodyClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    onAddIssue?.(status);
  }

  return (
    <div className={`group flex flex-col shrink-0 transition-[width,min-width] ${columnWidthClass}`}>
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        {isExpanded && (
          <>
            <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
              {issues.length}
            </span>
            {onAddIssue && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                title={addTitle}
                aria-label={addTitle}
                onClick={handleAddIssue}
              >
                <Plus className="h-3 w-3" />
              </Button>
            )}
          </>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
        onClick={handleColumnBodyClick}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              project={issue.project ?? (issue.projectId ? projectsById?.get(issue.projectId) ?? null : null)}
              isLive={liveIssueIds?.has(issue.id)}
              currentUserId={currentUserId}
              currentActorAgentIds={currentActorAgentIds}
              issueLinkState={issueLinkState}
              onUpdateIssue={onUpdateIssue}
            />
          ))}
        </SortableContext>
        {onAddIssue && (
          <button
            type="button"
            title={addTitle}
            aria-label={addTitle}
            className={`flex items-center justify-center rounded-md border border-dashed border-border/80 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/50 hover:text-foreground ${
              isExpanded ? "min-h-8 w-full gap-1.5 px-2" : "mx-auto h-7 w-7"
            }`}
            onClick={handleAddIssue}
          >
            <Plus className="h-3.5 w-3.5" />
            {isExpanded && <span>Add task</span>}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  project,
  isLive,
  isOverlay,
  currentUserId,
  currentActorAgentIds,
  issueLinkState,
  onUpdateIssue,
}: {
  issue: Issue;
  agents?: Agent[];
  project?: KanbanProject | null;
  isLive?: boolean;
  isOverlay?: boolean;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  issueLinkState?: unknown;
  onUpdateIssue?: (id: string, data: Record<string, unknown>) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };
  const issuePathId = issue.identifier ?? issue.id;
  const detailState = withIssueDetailHeaderSeed(issueLinkState, issue);
  const projectName = project?.name.trim() ?? "";
  const projectCode = project?.code?.trim() ?? "";
  const projectIndicatorLabel = projectCode || projectName;
  const projectIndicatorTitle = projectCode && projectName
    ? `Project: ${projectName} (${projectCode})`
    : projectIndicatorLabel
      ? `Project: ${projectIndicatorLabel}`
      : undefined;
  const todayDueDate = formatLocalDateOnly();
  const canSetDueToday =
    !isOverlay &&
    !!onUpdateIssue &&
    issue.dueDate !== todayDueDate &&
    !terminalIssueStatuses.has(issue.status);
  const assignedToCurrentUser = isIssueAssignedToCurrentActor(issue, {
    currentUserId,
    currentAgentIds: currentActorAgentIds,
  });

  function handleSetDueToday(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onUpdateIssue?.(issue.id, { dueDate: formatLocalDateOnly() });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-assigned-to-current-user={assignedToCurrentUser ? "true" : undefined}
      className={cn(
        "rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow",
        assignedToCurrentUser && "border-cyan-500/70 border-l-4 border-l-cyan-500 bg-cyan-500/15 ring-1 ring-cyan-500/50 dark:border-cyan-300/60 dark:border-l-cyan-300 dark:bg-cyan-400/15 dark:ring-cyan-300/40",
        isDragging && !isOverlay && "opacity-30",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
        assignedToCurrentUser && !isOverlay && "hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20",
      )}
    >
      <Link
        to={createIssueDetailPath(issuePathId)}
        state={detailState}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        {issue.coverAttachment ? (
          <div className="-mx-2.5 -mt-2.5 mb-2 aspect-[5/2] overflow-hidden rounded-t-md border-b border-border bg-muted">
            <img
              src={issue.coverAttachment.contentPath}
              alt={issue.coverAttachment.originalFilename ?? "Task cover"}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
        ) : null}
        <div className="mb-1.5 flex items-start gap-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {projectIndicatorLabel ? (
            <span
              data-testid="kanban-project-indicator"
              className="inline-flex min-w-0 max-w-[7rem] shrink items-center gap-1 rounded-sm border border-border/70 bg-muted/30 px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
              title={projectIndicatorTitle}
            >
              {project?.color ? (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                />
              ) : null}
              <span className="min-w-0 truncate">{projectIndicatorLabel}</span>
            </span>
          ) : null}
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          <IssueAssigneeIcon issue={issue} agents={agents} currentUserId={currentUserId} className="ml-auto -mt-1 shrink-0" />
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <PriorityIcon priority={issue.priority} />
        <IssueDueBadge issue={issue} compact />
        {(issue.labels ?? []).length > 0 ? (
          <LabelPills
            labels={issue.labels}
            maxVisible={2}
            className="min-w-0 max-w-full flex-1"
            overflowClassName="text-[10px]"
            pillClassName="max-w-[6.5rem] truncate px-1.5 py-0 text-[10px]"
          />
        ) : null}
        {(issue.links?.length ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${issue.links?.length ?? 0} link${(issue.links?.length ?? 0) === 1 ? "" : "s"}`}>
            <Link2 className="h-3 w-3" />
            {issue.links?.length}
          </span>
        ) : null}
        {issue.assigneeAgentId && !agents?.some((agent) => agent.id === issue.assigneeAgentId) && (() => {
          const name = agentName(issue.assigneeAgentId);
          return name ? (
            <Identity name={name} size="xs" />
          ) : (
            <span className="text-xs text-muted-foreground font-mono">
              {issue.assigneeAgentId.slice(0, 8)}
            </span>
          );
        })()}
        {canSetDueToday && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto h-5 w-5 text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300"
            title="Set due date to today"
            aria-label="Set due date to today"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleSetDueToday}
          >
            <Calendar className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  projects,
  liveIssueIds,
  currentUserId,
  issueLinkState,
  onUpdateIssue,
  onReorderIssue,
  onAddIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const currentActorAgentIds = useMemo(() => agents?.map((agent) => agent.id) ?? [], [agents]);
  const projectsById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    const reorderTarget = resolveKanbanReorderTarget(issues, issueId, over.id as string);
    if (!reorderTarget) return;

    if (onReorderIssue) {
      onReorderIssue(issueId, reorderTarget);
    } else if (reorderTarget.status !== issue.status) {
      onUpdateIssue(issueId, { status: reorderTarget.status });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            projectsById={projectsById}
            liveIssueIds={liveIssueIds}
            currentUserId={currentUserId}
            currentActorAgentIds={currentActorAgentIds}
            issueLinkState={issueLinkState}
            onUpdateIssue={onUpdateIssue}
            onAddIssue={onAddIssue}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            project={activeIssue.project ?? (activeIssue.projectId ? projectsById.get(activeIssue.projectId) ?? null : null)}
            currentUserId={currentUserId}
            currentActorAgentIds={currentActorAgentIds}
            issueLinkState={issueLinkState}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
