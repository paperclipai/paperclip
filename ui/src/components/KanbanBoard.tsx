import { useEffect, useMemo, useState } from "react";
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
import type { Issue, IssuePriority, IssueStatus } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { formatAssigneeUserLabel } from "../lib/assignees";
import type { InboxIssueColumn } from "../lib/inbox";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

export type KanbanGroupBy = "status" | "priority" | "assignee" | "project";

const KANBAN_NONE_KEY = "__none";
const KANBAN_COLUMN_PREFIXES: Record<Exclude<KanbanGroupBy, "status">, string> = {
  priority: "priority:",
  assignee: "assignee:",
  project: "project:",
};

const PRIORITY_ORDER: readonly IssuePriority[] = ["critical", "high", "medium", "low"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function priorityLabel(priority: string): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

function groupKeyFor(issue: Issue, groupBy: KanbanGroupBy): string {
  if (groupBy === "status") return issue.status;
  if (groupBy === "priority") return issue.priority ?? KANBAN_NONE_KEY;
  if (groupBy === "assignee") {
    if (issue.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue.assigneeUserId) return `user:${issue.assigneeUserId}`;
    return KANBAN_NONE_KEY;
  }
  if (groupBy === "project") return issue.projectId ?? KANBAN_NONE_KEY;
  return KANBAN_NONE_KEY;
}

function columnIdFor(groupBy: KanbanGroupBy, key: string): string {
  if (groupBy === "status") return key;
  return `${KANBAN_COLUMN_PREFIXES[groupBy]}${key}`;
}

function parseColumnId(id: string): { groupBy: KanbanGroupBy; key: string } | null {
  if (id.startsWith("priority:")) return { groupBy: "priority", key: id.slice("priority:".length) };
  if (id.startsWith("assignee:")) return { groupBy: "assignee", key: id.slice("assignee:".length) };
  if (id.startsWith("project:")) return { groupBy: "project", key: id.slice("project:".length) };
  if ((boardStatuses as readonly string[]).includes(id)) return { groupBy: "status", key: id };
  return null;
}

export function resolveKanbanTargetStatus(overId: string, issues: Issue[]): IssueStatus | null {
  if ((boardStatuses as readonly string[]).includes(overId)) {
    return overId as IssueStatus;
  }
  return issues.find((issue) => issue.id === overId)?.status ?? null;
}

interface Agent {
  id: string;
  name: string;
}

interface Project {
  name: string;
  color: string | null;
}

export interface KanbanColumnDescriptor {
  id: string;
  key: string;
  label: string;
  color?: string | null;
  isNone?: boolean;
}

export function buildKanbanColumns(
  groupBy: KanbanGroupBy,
  issues: Issue[],
  options: {
    agents?: ReadonlyArray<Agent>;
    projectsById?: ReadonlyMap<string, Project>;
    currentUserId?: string | null;
  } = {},
): KanbanColumnDescriptor[] {
  if (groupBy === "status") {
    return boardStatuses.map((status) => ({
      id: columnIdFor("status", status),
      key: status,
      label: statusLabel(status),
    }));
  }

  if (groupBy === "priority") {
    const present = new Set(issues.map((i) => i.priority).filter(Boolean) as IssuePriority[]);
    const ordered = PRIORITY_ORDER.filter((p) => present.has(p));
    const cols: KanbanColumnDescriptor[] = ordered.map((priority) => ({
      id: columnIdFor("priority", priority),
      key: priority,
      label: priorityLabel(priority),
    }));
    if (issues.some((i) => !i.priority)) {
      cols.push({ id: columnIdFor("priority", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "(none)", isNone: true });
    }
    if (cols.length === 0) {
      cols.push({ id: columnIdFor("priority", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "(none)", isNone: true });
    }
    return cols;
  }

  if (groupBy === "assignee") {
    const seen = new Set<string>();
    const cols: KanbanColumnDescriptor[] = [];
    const agentName = (id: string) => options.agents?.find((a) => a.id === id)?.name ?? id.slice(0, 8);
    let hasNone = false;
    for (const issue of issues) {
      const key = groupKeyFor(issue, "assignee");
      if (key === KANBAN_NONE_KEY) {
        hasNone = true;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      let label: string;
      if (key.startsWith("agent:")) {
        label = agentName(key.slice("agent:".length));
      } else if (key.startsWith("user:")) {
        const userId = key.slice("user:".length);
        label = formatAssigneeUserLabel(userId, options.currentUserId ?? null) ?? "User";
      } else {
        label = key;
      }
      cols.push({ id: columnIdFor("assignee", key), key, label });
    }
    cols.sort((a, b) => a.label.localeCompare(b.label));
    if (hasNone) {
      cols.push({ id: columnIdFor("assignee", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "Unassigned", isNone: true });
    }
    if (cols.length === 0) {
      cols.push({ id: columnIdFor("assignee", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "Unassigned", isNone: true });
    }
    return cols;
  }

  // project
  const seen = new Set<string>();
  const cols: KanbanColumnDescriptor[] = [];
  let hasNone = false;
  for (const issue of issues) {
    const key = groupKeyFor(issue, "project");
    if (key === KANBAN_NONE_KEY) {
      hasNone = true;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const project = options.projectsById?.get(key);
    const label = project?.name ?? key.slice(0, 8);
    cols.push({ id: columnIdFor("project", key), key, label, color: project?.color ?? null });
  }
  cols.sort((a, b) => a.label.localeCompare(b.label));
  if (hasNone) {
    cols.push({ id: columnIdFor("project", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "No project", isNone: true });
  }
  if (cols.length === 0) {
    cols.push({ id: columnIdFor("project", KANBAN_NONE_KEY), key: KANBAN_NONE_KEY, label: "No project", isNone: true });
  }
  return cols;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  projectsById?: ReadonlyMap<string, Project>;
  currentUserId?: string | null;
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  groupBy?: KanbanGroupBy;
  cardColumns?: ReadonlySet<InboxIssueColumn>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  column,
  issues,
  agents,
  projectsById,
  currentUserId,
  liveIssueIds,
  compactCards = false,
  collapsed = false,
  visibleCount,
  revealIncrement,
  cardColumns,
  showStatusIcon,
  onShowMore,
}: {
  column: KanbanColumnDescriptor;
  issues: Issue[];
  agents?: Agent[];
  projectsById?: ReadonlyMap<string, Project>;
  currentUserId?: string | null;
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  cardColumns?: ReadonlySet<InboxIssueColumn>;
  showStatusIcon: boolean;
  onShowMore: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const isEmpty = issues.length === 0;
  const visibleIssues = collapsed ? [] : issues.slice(0, visibleCount);
  const hiddenCount = Math.max(issues.length - visibleIssues.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);

  const headerIcon = showStatusIcon ? (
    <StatusIcon status={column.key as IssueStatus} />
  ) : column.color ? (
    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: column.color }} />
  ) : (
    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" />
  );

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={`flex min-h-[220px] w-[52px] shrink-0 flex-col items-center rounded-md border border-border bg-muted/20 px-1.5 py-2 transition-colors ${
          isOver ? "bg-accent/50 ring-1 ring-primary/20" : ""
        }`}
        title={`${column.label}: ${issues.length}`}
      >
        {headerIcon}
        <span className="mt-2 [writing-mode:vertical-rl] rotate-180 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {column.label}
        </span>
        <span className="mt-auto rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {issues.length}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col shrink-0 transition-[width,min-width] ${isEmpty && !isOver ? "min-w-[48px] w-[48px]" : "min-w-[260px] w-[260px]"}`}>
      <div className={`flex items-center gap-2 px-2 py-2 mb-1 ${isEmpty && !isOver ? "justify-center" : ""}`}>
        {headerIcon}
        {(!isEmpty || isOver) && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
              {column.label}
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
        {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
        <SortableContext
          items={visibleIssues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {visibleIssues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              projectsById={projectsById}
              currentUserId={currentUserId}
              isLive={liveIssueIds?.has(issue.id)}
              compact={compactCards}
              cardColumns={cardColumns}
            />
          ))}
        </SortableContext>
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={onShowMore}
          >
            Show {nextRevealCount} more
          </button>
        ) : null}
        {issues.length > 0 && (hiddenCount > 0 || issues.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-[11px] text-muted-foreground">
            Showing {visibleIssues.length} of {issues.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  projectsById,
  currentUserId,
  isLive,
  isOverlay,
  compact = false,
  cardColumns,
}: {
  issue: Issue;
  agents?: Agent[];
  projectsById?: ReadonlyMap<string, Project>;
  currentUserId?: string | null;
  isLive?: boolean;
  isOverlay?: boolean;
  compact?: boolean;
  cardColumns?: ReadonlySet<InboxIssueColumn>;
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

  const showAssignee = cardColumns ? cardColumns.has("assignee") : true;
  const showProject = cardColumns ? cardColumns.has("project") : true;
  const showLabels = cardColumns ? cardColumns.has("labels") : false;

  const project = issue.projectId ? projectsById?.get(issue.projectId) ?? null : null;
  const labelChips = (issue.labels ?? []).slice(0, 2);
  const extraLabelCount = Math.max((issue.labels ?? []).length - labelChips.length, 0);
  const userLabel = issue.assigneeUserId
    ? formatAssigneeUserLabel(issue.assigneeUserId, currentUserId ?? null) ?? "User"
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"} ${
        compact ? "p-2" : "p-2.5"
      }`}
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
        <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isSuccessfulRunHandoffRequired(issue) ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-400/45 bg-amber-50/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
              title="This issue needs a next step"
              aria-label="Needs next step"
            >
              <AlertTriangle className="h-3 w-3" />
              Next step
            </span>
          ) : null}
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {compact ? "Live" : null}
            </span>
          )}
        </div>
        <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{issue.title}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="inline-flex items-center gap-1" title={`Priority: ${priorityLabel(issue.priority)}`}>
            <PriorityIcon priority={issue.priority} />
            <span className="text-[11px] font-medium text-muted-foreground">{priorityLabel(issue.priority)}</span>
          </span>
          {showAssignee && issue.assigneeAgentId ? (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })() : null}
          {showAssignee && !issue.assigneeAgentId && issue.assigneeUserId && userLabel ? (
            <Identity name={userLabel} size="xs" />
          ) : null}
          {showProject && project ? (() => {
            const accentColor = project.color ?? "#64748b";
            return (
              <span
                className="inline-flex max-w-[160px] items-center gap-1 truncate text-[11px] font-medium"
                style={{ color: pickTextColorForPillBg(accentColor, 0.12) }}
                title={project.name}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
                <span className="truncate">{project.name}</span>
              </span>
            );
          })() : null}
          {showLabels && labelChips.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {labelChips.map((label) => (
                <span
                  key={label.id}
                  className="inline-flex max-w-[100px] shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: pickTextColorForPillBg(label.color, 0.12),
                    backgroundColor: `${label.color}1f`,
                  }}
                  title={label.name}
                >
                  <span className="truncate">{label.name}</span>
                </span>
              ))}
              {extraLabelCount > 0 ? (
                <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                  +{extraLabelCount}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  projectsById,
  currentUserId,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  groupBy = "status",
  cardColumns,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [visibleCountByColumn, setVisibleCountByColumn] = useState<Record<string, number>>({});
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  useEffect(() => {
    setVisibleCountByColumn({});
  }, [initialVisibleCount, revealIncrement, groupBy]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columns = useMemo(
    () => buildKanbanColumns(groupBy, issues, { agents, projectsById, currentUserId }),
    [groupBy, issues, agents, projectsById, currentUserId],
  );

  const issuesByColumn = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const column of columns) grouped[column.key] = [];
    for (const issue of issues) {
      const key = groupKeyFor(issue, groupBy);
      if (!grouped[key]) grouped[key] = [];
      grouped[key]!.push(issue);
    }
    return grouped;
  }, [columns, issues, groupBy]);

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

    const overId = over.id as string;

    // Determine the target column. The "over" could be a column id or another card's id.
    let targetColumn = parseColumnId(overId);
    if (!targetColumn) {
      const overIssue = issues.find((i) => i.id === overId);
      if (overIssue) {
        targetColumn = { groupBy, key: groupKeyFor(overIssue, groupBy) };
      }
    }
    if (!targetColumn) return;

    // Only mutate when the drop crosses columns relative to the current grouping
    const sourceKey = groupKeyFor(issue, targetColumn.groupBy);
    if (sourceKey === targetColumn.key) return;

    if (targetColumn.groupBy === "status") {
      onUpdateIssue(issueId, { status: targetColumn.key as IssueStatus });
      return;
    }
    if (targetColumn.groupBy === "priority") {
      if (targetColumn.key === KANBAN_NONE_KEY) return; // priority is required
      onUpdateIssue(issueId, { priority: targetColumn.key as IssuePriority });
      return;
    }
    if (targetColumn.groupBy === "assignee") {
      if (targetColumn.key === KANBAN_NONE_KEY) {
        onUpdateIssue(issueId, { assigneeAgentId: null, assigneeUserId: null });
        return;
      }
      if (targetColumn.key.startsWith("agent:")) {
        const agentId = targetColumn.key.slice("agent:".length);
        onUpdateIssue(issueId, { assigneeAgentId: agentId, assigneeUserId: null });
      } else if (targetColumn.key.startsWith("user:")) {
        const userId = targetColumn.key.slice("user:".length);
        onUpdateIssue(issueId, { assigneeAgentId: null, assigneeUserId: userId });
      }
      return;
    }
    if (targetColumn.groupBy === "project") {
      if (targetColumn.key === KANBAN_NONE_KEY) {
        onUpdateIssue(issueId, { projectId: null });
      } else {
        onUpdateIssue(issueId, { projectId: targetColumn.key });
      }
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
        {columns.map((column) => {
          const collapsed = groupBy === "status" && collapsedStatusSet.has(column.key);
          return (
            <KanbanColumn
              key={column.id}
              column={column}
              issues={issuesByColumn[column.key] ?? []}
              agents={agents}
              projectsById={projectsById}
              currentUserId={currentUserId}
              liveIssueIds={liveIssueIds}
              compactCards={compactCards}
              collapsed={collapsed}
              visibleCount={visibleCountByColumn[column.key] ?? initialVisibleCount}
              revealIncrement={revealIncrement}
              cardColumns={cardColumns}
              showStatusIcon={groupBy === "status"}
              onShowMore={() => {
                setVisibleCountByColumn((current) => ({
                  ...current,
                  [column.key]: (current[column.key] ?? initialVisibleCount) + revealIncrement,
                }));
              }}
            />
          );
        })}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            projectsById={projectsById}
            currentUserId={currentUserId}
            isOverlay
            compact={compactCards}
            cardColumns={cardColumns}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
