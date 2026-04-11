import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { CHAIN_STALL_THRESHOLD_MS, TERMINAL_ISSUE_STATUSES } from "@paperclipai/shared";
import type { Issue } from "@paperclipai/shared";

const swimlaneStatuses = ["todo", "in_progress", "in_review", "done"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

interface InitiativeBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Health calculation ── */

const STALE_THRESHOLD_MS = CHAIN_STALL_THRESHOLD_MS;
const COLLAPSE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

interface InitiativeHealth {
  total: number;
  doneCount: number;
  blockedCount: number;
  lastMovedAt: Date | null;
  color: "green" | "yellow" | "red";
  stale: boolean;
}

function computeHealth(children: Issue[]): InitiativeHealth {
  const total = children.length;
  const doneCount = children.filter(
    (c) => TERMINAL_ISSUE_STATUSES.includes(c.status as typeof TERMINAL_ISSUE_STATUSES[number]),
  ).length;
  const blockedCount = children.filter((c) => c.status === "blocked").length;

  let lastMovedAt: Date | null = null;
  for (const child of children) {
    const updated = new Date(child.updatedAt);
    if (!lastMovedAt || updated > lastMovedAt) lastMovedAt = updated;
  }

  const elapsed = lastMovedAt ? Date.now() - lastMovedAt.getTime() : Infinity;
  const stale = elapsed > COLLAPSE_THRESHOLD_MS;
  let color: "green" | "yellow" | "red" = "green";
  if (elapsed > STALE_THRESHOLD_MS) color = "red";
  else if (blockedCount > 0) color = "yellow";

  return { total, doneCount, blockedCount, lastMovedAt, color, stale };
}

/* ── Mini card for swimlane ── */

function SwimCard({
  issue,
  agents,
  isLive,
  isOverlay,
  rowId,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
  rowId: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    data: { issue, rowId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded border bg-card p-2 cursor-grab active:cursor-grabbing text-xs ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => { if (isDragging) e.preventDefault(); }}
      >
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[10px] text-muted-foreground font-mono">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
          )}
        </div>
        <p className="leading-snug line-clamp-2 mb-1">{issue.title}</p>
        <div className="flex items-center gap-1.5">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? <Identity name={name} size="xs" /> : null;
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Droppable cell (status column within a row) ── */

function SwimCell({
  status,
  issues: cellIssues,
  agents,
  liveIssueIds,
  rowId,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  rowId: string;
}) {
  const droppableId = `${rowId}::${status}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-[180px] min-h-[80px] rounded p-1 space-y-1 transition-colors ${
        isOver ? "bg-accent/40" : "bg-muted/10"
      }`}
    >
      <SortableContext
        items={cellIssues.map((i) => i.id)}
        strategy={verticalListSortingStrategy}
      >
        {cellIssues.map((issue) => (
          <SwimCard
            key={issue.id}
            issue={issue}
            agents={agents}
            isLive={liveIssueIds?.has(issue.id)}
            rowId={rowId}
          />
        ))}
      </SortableContext>
      {cellIssues.length === 0 && (
        <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground/50 py-4">
          ---
        </div>
      )}
    </div>
  );
}

/* ── Initiative row ── */

function InitiativeRow({
  initiative,
  children,
  agents,
  liveIssueIds,
  defaultOpen,
}: {
  initiative: Issue;
  children: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  defaultOpen: boolean;
}) {
  const health = computeHealth(children);

  const healthDotColor =
    health.color === "red"
      ? "bg-red-500"
      : health.color === "yellow"
        ? "bg-yellow-500"
        : "bg-green-500";

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const s of swimlaneStatuses) grouped[s] = [];
    for (const child of children) {
      // Map statuses to the 4 swim columns
      const mapped =
        child.status === "backlog" || child.status === "todo"
          ? "todo"
          : child.status === "in_progress" || child.status === "blocked"
            ? "in_progress"
            : child.status === "in_review"
              ? "in_review"
              : "done";
      grouped[mapped]?.push(child);
    }
    return grouped;
  }, [children]);

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Initiative header */}
        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 hover:bg-accent/30 transition-colors text-left">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
          <span className={`h-2 w-2 rounded-full shrink-0 ${healthDotColor}`} />
          <span className="text-sm font-semibold truncate">
            {initiative.identifier && (
              <span className="text-muted-foreground font-mono mr-1.5">{initiative.identifier}</span>
            )}
            {initiative.title}
          </span>
          <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
            {health.doneCount}/{health.total} complete
            {health.blockedCount > 0 && (
              <span className="text-red-500 ml-2">{health.blockedCount} blocked</span>
            )}
            {health.lastMovedAt && (
              <span className="ml-2">last moved {timeAgo(health.lastMovedAt)}</span>
            )}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          {children.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              0 tasks -- waiting for work
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div className="flex gap-1 px-3 py-1 border-t border-border bg-muted/30">
                {swimlaneStatuses.map((s) => (
                  <div key={s} className="flex-1 min-w-[180px]">
                    <div className="flex items-center gap-1.5 px-1">
                      <StatusIcon status={s} />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {statusLabel(s)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50 ml-auto tabular-nums">
                        {(columnIssues[s] ?? []).length}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Cells */}
              <div className="flex gap-1 px-3 py-2">
                {swimlaneStatuses.map((s) => (
                  <SwimCell
                    key={s}
                    status={s}
                    issues={columnIssues[s] ?? []}
                    agents={agents}
                    liveIssueIds={liveIssueIds}
                    rowId={initiative.id}
                  />
                ))}
              </div>
            </>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Main Board ── */

export function InitiativeBoard({
  issues,
  agents,
  liveIssueIds,
  onUpdateIssue,
}: InitiativeBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Separate initiatives and tasks
  const { initiatives, tasksByParent, orphanTasks } = useMemo(() => {
    const inits: Issue[] = [];
    const tasks: Issue[] = [];
    for (const issue of issues) {
      if (issue.issueType === "initiative") {
        inits.push(issue);
      } else {
        tasks.push(issue);
      }
    }

    const byParent: Record<string, Issue[]> = {};
    const orphans: Issue[] = [];
    for (const task of tasks) {
      if (task.parentId && inits.some((i) => i.id === task.parentId)) {
        if (!byParent[task.parentId]) byParent[task.parentId] = [];
        byParent[task.parentId].push(task);
      } else {
        orphans.push(task);
      }
    }

    return { initiatives: inits, tasksByParent: byParent, orphanTasks: orphans };
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues],
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

    // The droppable ID format is "initiativeId::status"
    const overId = over.id as string;
    const parts = overId.split("::");
    if (parts.length !== 2) return;

    const [_rowId, targetStatus] = parts;
    if (!targetStatus || !swimlaneStatuses.includes(targetStatus)) return;

    // Enforce same-row: the card's rowId must match the drop target
    const activeData = active.data.current as { rowId?: string } | undefined;
    if (activeData?.rowId && activeData.rowId !== _rowId) return;

    if (targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-3">
        {initiatives.map((init) => {
          const children = tasksByParent[init.id] ?? [];
          const health = computeHealth(children);
          return (
            <InitiativeRow
              key={init.id}
              initiative={init}
              children={children}
              agents={agents}
              liveIssueIds={liveIssueIds}
              defaultOpen={!health.stale}
            />
          );
        })}

        {orphanTasks.length > 0 && (
          <div className="border border-dashed border-border rounded-lg p-3">
            <div className="text-xs text-muted-foreground mb-2">
              {orphanTasks.length} task{orphanTasks.length !== 1 ? "s" : ""} without initiative
            </div>
            <div className="flex gap-1">
              {swimlaneStatuses.map((s) => {
                const cellIssues = orphanTasks.filter((t) => {
                  const mapped =
                    t.status === "backlog" || t.status === "todo"
                      ? "todo"
                      : t.status === "in_progress" || t.status === "blocked"
                        ? "in_progress"
                        : t.status === "in_review"
                          ? "in_review"
                          : "done";
                  return mapped === s;
                });
                return (
                  <SwimCell
                    key={s}
                    status={s}
                    issues={cellIssues}
                    agents={agents}
                    liveIssueIds={liveIssueIds}
                    rowId="__orphan"
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      <DragOverlay>
        {activeIssue ? (
          <SwimCard issue={activeIssue} agents={agents} isOverlay rowId="" />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
