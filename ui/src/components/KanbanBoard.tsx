import { useMemo, useState } from "react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { IssueAssigneeIcon } from "./IssueAssigneeIcon";
import { isIssueAssignedToCurrentActor } from "../lib/assignees";
import { cn } from "../lib/utils";
import type { Issue } from "@paperclipai/shared";

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

interface Agent {
  id: string;
  name: string;
  icon?: string | null;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  currentUserId?: string | null;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
  currentUserId,
  currentActorAgentIds,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const isEmpty = issues.length === 0;

  return (
    <div className={`flex flex-col shrink-0 transition-[width,min-width] ${isEmpty && !isOver ? "min-w-[48px] w-[48px]" : "min-w-[260px] w-[260px]"}`}>
      <div className={`flex items-center gap-2 px-2 py-2 mb-1 ${isEmpty && !isOver ? "justify-center" : ""}`}>
        <StatusIcon status={status} />
        {(!isEmpty || isOver) && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {statusLabel(status)}
            </span>
            <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
              {issues.length}
            </span>
          </>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
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
              isLive={liveIssueIds?.has(issue.id)}
              currentUserId={currentUserId}
              currentActorAgentIds={currentActorAgentIds}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  isOverlay,
  currentUserId,
  currentActorAgentIds,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
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

  const assignedToCurrentUser = isIssueAssignedToCurrentActor(issue, {
    currentUserId,
    currentAgentIds: currentActorAgentIds,
  });

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
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          <IssueAssigneeIcon issue={issue} agents={agents} currentUserId={currentUserId} />
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  currentUserId,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const currentActorAgentIds = useMemo(() => agents?.map((agent) => agent.id) ?? [], [agents]);

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

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
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
            liveIssueIds={liveIssueIds}
            currentUserId={currentUserId}
            currentActorAgentIds={currentActorAgentIds}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            currentUserId={currentUserId}
            currentActorAgentIds={currentActorAgentIds}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
