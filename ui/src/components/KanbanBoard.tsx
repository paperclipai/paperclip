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
import { Identity } from "./Identity";
import {
  issueExecutionIndicatorClassName,
  resolveIssueExecutionIndicator,
} from "../lib/issue-execution-indicator";
import { formatIssueStatusLabel } from "../lib/issue-status-labels";
import { timeAgo } from "../lib/timeAgo";
import { formatDateTime } from "../lib/utils";
import type { HeartbeatIssueExecutionSummary, Issue } from "@paperclipai/shared";

const COLUMN_PAGE_SIZE = 15;

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function qaBadgeClass(value: string) {
  if (value === "pass") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (value === "warn") return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  if (value === "fail") return "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
  return "border-muted bg-muted/40 text-muted-foreground";
}

function formatQaBadge(value: string) {
  if (value === "unknown") return "Review";
  return value.toUpperCase();
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  allIssues?: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  issueExecutionSummariesByIssueId?: Map<string, HeartbeatIssueExecutionSummary>;
  epicStylesByIssueId?: Map<string, { cardClassName: string }>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  filteredOutCount,
  visibleCount,
  onShowMore,
  agents,
  liveIssueIds,
  issueExecutionSummariesByIssueId,
  epicStylesByIssueId,
}: {
  status: string;
  issues: Issue[];
  filteredOutCount: number;
  visibleCount: number;
  onShowMore: () => void;
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  issueExecutionSummariesByIssueId?: Map<string, HeartbeatIssueExecutionSummary>;
  epicStylesByIssueId?: Map<string, { cardClassName: string }>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const visibleIssues = issues.slice(0, visibleCount);
  const hiddenCount = Math.max(0, issues.length - visibleIssues.length);
  const totalCount = issues.length + filteredOutCount;
  const isEmpty = totalCount === 0;

  return (
    <div
      data-kanban-column-status={status}
      className="flex w-[260px] min-w-[260px] shrink-0 flex-col"
    >
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
          {formatIssueStatusLabel(status)}
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
          {totalCount}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={visibleIssues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {visibleIssues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
              issueExecutionSummary={issueExecutionSummariesByIssueId?.get(issue.id)}
              epicCardClassName={epicStylesByIssueId?.get(issue.id)?.cardClassName}
            />
          ))}
        </SortableContext>
        {isEmpty && (
          <div
            data-kanban-empty-placeholder={status}
            className="rounded-md border border-dashed border-border bg-background/70 px-2.5 py-6 text-center text-xs text-muted-foreground"
          >
            No issues
          </div>
        )}
        {filteredOutCount > 0 && (
          <div
            data-kanban-filtered-placeholder={status}
            className="rounded-md border border-dashed border-border bg-background/70 px-2.5 py-2 text-xs text-muted-foreground"
          >
            {filteredOutCount} issue{filteredOutCount === 1 ? "" : "s"} hidden by current filters
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={onShowMore}
            className="mt-1 w-full rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
          >
            Show {Math.min(COLUMN_PAGE_SIZE, hiddenCount)} more ({hiddenCount} hidden)
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
  isLive,
  issueExecutionSummary,
  isOverlay,
  epicCardClassName,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  issueExecutionSummary?: HeartbeatIssueExecutionSummary;
  isOverlay?: boolean;
  epicCardClassName?: string;
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
  const executionIndicator = resolveIssueExecutionIndicator(issueExecutionSummary, Boolean(isLive));

  return (
    <div
      ref={setNodeRef}
      data-kanban-card-id={issue.id}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"} ${epicCardClassName ?? ""}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="flex min-w-0 items-start gap-1.5">
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
            {executionIndicator && (
              <span
                title={executionIndicator.title}
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${issueExecutionIndicatorClassName(executionIndicator.tone)}`}
              >
                {executionIndicator.pulse ? (
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                  </span>
                ) : null}
                <span>{executionIndicator.label}</span>
              </span>
            )}
          </span>
          <span
            className="ml-auto shrink-0 text-[11px] text-muted-foreground"
            title={formatDateTime(issue.updatedAt)}
          >
            Updated {timeAgo(issue.updatedAt)}
          </span>
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        {issue.status === "in_review" && issue.qaGate?.review && (
          <div className="mb-2 flex items-center gap-1.5">
            <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${qaBadgeClass(issue.qaGate.review.overall)}`}>
              {formatQaBadge(issue.qaGate.review.overall)}
            </span>
            {issue.qaGate.review.stale && (
              <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                Stale
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  allIssues,
  agents,
  liveIssueIds,
  issueExecutionSummariesByIssueId,
  epicStylesByIssueId,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [visibleCountByStatus, setVisibleCountByStatus] = useState<Record<string, number>>(() => ({
    backlog: COLUMN_PAGE_SIZE,
    todo: COLUMN_PAGE_SIZE,
    in_progress: COLUMN_PAGE_SIZE,
    in_review: COLUMN_PAGE_SIZE,
    blocked: COLUMN_PAGE_SIZE,
    done: COLUMN_PAGE_SIZE,
    cancelled: COLUMN_PAGE_SIZE,
  }));

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

  const sourceColumnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of allIssues ?? issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [allIssues, issues]);

  const filteredOutCountByStatus = useMemo(
    () =>
      Object.fromEntries(
        boardStatuses.map((status) => [
          status,
          Math.max(0, (sourceColumnIssues[status]?.length ?? 0) - (columnIssues[status]?.length ?? 0)),
        ]),
      ) as Record<string, number>,
    [columnIssues, sourceColumnIssues],
  );

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
    <div className="space-y-3">
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
              filteredOutCount={filteredOutCountByStatus[status] ?? 0}
              visibleCount={visibleCountByStatus[status] ?? COLUMN_PAGE_SIZE}
              onShowMore={() =>
                setVisibleCountByStatus((prev) => ({
                  ...prev,
                  [status]: (prev[status] ?? COLUMN_PAGE_SIZE) + COLUMN_PAGE_SIZE,
                }))
              }
              agents={agents}
              liveIssueIds={liveIssueIds}
              issueExecutionSummariesByIssueId={issueExecutionSummariesByIssueId}
              epicStylesByIssueId={epicStylesByIssueId}
            />
          ))}
        </div>
        <DragOverlay>
          {activeIssue ? (
            <KanbanCard
              issue={activeIssue}
              agents={agents}
              isLive={liveIssueIds?.has(activeIssue.id)}
              issueExecutionSummary={issueExecutionSummariesByIssueId?.get(activeIssue.id)}
              isOverlay
              epicCardClassName={epicStylesByIssueId?.get(activeIssue.id)?.cardClassName}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
