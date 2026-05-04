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
import { Button } from "@/components/ui/button";
import { CalendarDays, CheckSquare, GripVertical, Link2, Plus, X } from "lucide-react";
import type {
  Issue,
  IssuePriority,
  IssueStatus,
  IssueWorkProduct,
  Rt2BoardAttachmentPreview,
  Rt2BoardCardMeta,
} from "@paperclipai/shared";

const boardStatuses: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const boardLanes: Array<{ id: IssueStatus; label: string; description: string; statuses: IssueStatus[] }> = [
  {
    id: "todo",
    label: "할 일",
    description: "아직 시작하지 않은 Task와 To-Do",
    statuses: ["backlog", "todo", "blocked"],
  },
  {
    id: "in_progress",
    label: "진행 중",
    description: "작업 중이거나 검토 중인 카드",
    statuses: ["in_progress", "in_review"],
  },
  {
    id: "done",
    label: "완료",
    description: "완료 또는 취소된 카드",
    statuses: ["done", "cancelled"],
  },
];

const priorityOptions: IssuePriority[] = ["critical", "high", "medium", "low"];

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    backlog: "대기",
    todo: "할 일",
    in_progress: "진행 중",
    in_review: "검토",
    blocked: "막힘",
    done: "완료",
    cancelled: "취소",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

function priorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    critical: "긴급",
    high: "높음",
    medium: "보통",
    low: "낮음",
  };
  return labels[priority] ?? priority;
}

function isBoardStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (boardStatuses as readonly string[]).includes(value);
}

function laneForStatus(status: IssueStatus) {
  return boardLanes.find((lane) => lane.statuses.includes(status)) ?? boardLanes[0]!;
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function readBasePrice(workProduct: IssueWorkProduct): number | null {
  const metadata = workProduct.metadata ?? {};
  const raw =
    metadata.basePrice ??
    metadata.basePriceCents ??
    metadata.price ??
    metadata.actualPrice ??
    metadata.actualPriceCents ??
    null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function summarizeDeliverables(issue: Issue) {
  const workProducts = issue.workProducts ?? [];
  const basePriceTotal = workProducts.reduce((sum, workProduct) => sum + (readBasePrice(workProduct) ?? 0), 0);
  const primary = workProducts.find((workProduct) => workProduct.isPrimary) ?? workProducts[0] ?? null;
  return {
    count: workProducts.length,
    basePriceTotal,
    primaryTitle: primary?.title ?? null,
  };
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  boardCards?: Map<string, Rt2BoardCardMeta>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onUpdateBoardCard?: (id: string, data: Partial<Pick<Rt2BoardCardMeta, "dueDate" | "qualityStatus" | "priceGold" | "detailNotes">>) => void;
  onAddChecklistItem?: (id: string, title: string) => void;
  onUpdateChecklistItem?: (id: string, itemId: string, data: { title?: string; checked?: boolean }) => void;
  onReorderChecklist?: (id: string, orderedItemIds: string[]) => void;
  onAddAttachment?: (id: string, data: { label: string; url: string; contentType?: string | null }) => void;
  onCreateTask?: (status?: string) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  lane,
  issues,
  totalCount,
  agents,
  liveIssueIds,
  boardCards,
  childCountsByParent,
  onUpdateIssue,
  onUpdateBoardCard,
  onAddChecklistItem,
  onUpdateChecklistItem,
  onReorderChecklist,
  onAddAttachment,
  onCreateTask,
}: {
  lane: (typeof boardLanes)[number];
  issues: Issue[];
  totalCount: number;
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  boardCards?: Map<string, Rt2BoardCardMeta>;
  childCountsByParent: Map<string, number>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onUpdateBoardCard?: KanbanBoardProps["onUpdateBoardCard"];
  onAddChecklistItem?: KanbanBoardProps["onAddChecklistItem"];
  onUpdateChecklistItem?: KanbanBoardProps["onUpdateChecklistItem"];
  onReorderChecklist?: KanbanBoardProps["onReorderChecklist"];
  onAddAttachment?: KanbanBoardProps["onAddAttachment"];
  onCreateTask?: (status?: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id });

  const isEmpty = issues.length === 0;

  return (
    <section className="flex min-w-[21rem] w-[21rem] shrink-0 flex-col rounded-md border border-border bg-muted/30" aria-label={`${lane.label} list`}>
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={lane.id} />
          <span className="text-sm font-semibold text-foreground">{lane.label}</span>
          <span className="ml-auto rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
            {issues.length}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{lane.description}</p>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[220px] space-y-2 p-2 transition-colors ${
          isOver ? "bg-accent/40" : ""
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
              boardCard={boardCards?.get(issue.id)}
              childCount={childCountsByParent.get(issue.id) ?? 0}
              onUpdateIssue={onUpdateIssue}
              onUpdateBoardCard={onUpdateBoardCard}
              onAddChecklistItem={onAddChecklistItem}
              onUpdateChecklistItem={onUpdateChecklistItem}
              onReorderChecklist={onReorderChecklist}
              onAddAttachment={onAddAttachment}
            />
          ))}
        </SortableContext>
        {isEmpty ? (
          <div className="rounded-md border border-dashed border-border bg-background/60 px-3 py-6 text-center text-xs text-muted-foreground">
            이 리스트에 카드가 없습니다.
          </div>
        ) : null}
      </div>
      <div className="border-t border-border p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs text-muted-foreground"
          onClick={() => onCreateTask?.(lane.id)}
        >
          + {lane.label} 카드 추가
        </Button>
      </div>
      {totalCount > 0 ? (
        <div className="sr-only">{lane.label} list contains {issues.length} of {totalCount} tasks.</div>
      ) : null}
    </section>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  boardCard,
  childCount,
  onUpdateIssue,
  onUpdateBoardCard,
  onAddChecklistItem,
  onUpdateChecklistItem,
  onReorderChecklist,
  onAddAttachment,
  isOverlay,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  boardCard?: Rt2BoardCardMeta;
  childCount?: number;
  onUpdateIssue?: (id: string, data: Record<string, unknown>) => void;
  onUpdateBoardCard?: KanbanBoardProps["onUpdateBoardCard"];
  onAddChecklistItem?: KanbanBoardProps["onAddChecklistItem"];
  onUpdateChecklistItem?: KanbanBoardProps["onUpdateChecklistItem"];
  onReorderChecklist?: KanbanBoardProps["onReorderChecklist"];
  onAddAttachment?: KanbanBoardProps["onAddAttachment"];
  isOverlay?: boolean;
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
  const deliverables = summarizeDeliverables(issue);
  const isTodo = Boolean(issue.parentId);
  const okrLabel = issue.goal?.title ?? (issue.goalId ? "OKR 연결" : "OKR 없음");
  const assigneeName = issue.assigneeAgentId ? agentName(issue.assigneeAgentId) : null;
  const [expanded, setExpanded] = useState(false);
  const [checklistTitle, setChecklistTitle] = useState("");
  const [attachmentDraft, setAttachmentDraft] = useState({ label: "", url: "" });
  const combinedAttachments: Rt2BoardAttachmentPreview[] = [
    ...(boardCard?.attachments ?? []),
    ...((issue.workProducts ?? [])
      .filter((workProduct) => Boolean(workProduct.url))
      .slice(0, 2)
      .map((workProduct, index) => ({
        id: `work-product:${workProduct.id}`,
        issueId: issue.id,
        label: workProduct.title,
        url: workProduct.url!,
        contentType: null,
        previewKind: "link" as const,
        position: 100 + index,
      }))),
  ];

  return (
    <article
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-3 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
      aria-label={`${issue.title} task card`}
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
        <div className="mb-2 flex items-start gap-1.5">
          <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          <span className="rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {isTodo ? "To-Do" : "Task"}
          </span>
          {issue.status !== laneForStatus(issue.status).id ? (
            <span className="rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
              {statusLabel(issue.status)}
            </span>
          ) : null}
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
        </div>
        <p className="mb-3 line-clamp-3 text-sm font-medium leading-snug">{issue.title}</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${deliverables.count > 0 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
            산출물 {deliverables.count}
          </span>
          <span className="rounded-sm bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300">
            {deliverables.basePriceTotal > 0 ? `${formatPrice(deliverables.basePriceTotal)}원` : "가격 미정"}
          </span>
          <span className={`max-w-full truncate rounded-sm px-1.5 py-0.5 text-[11px] ${issue.goalId ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-muted text-muted-foreground"}`}>
            {okrLabel}
          </span>
          {boardCard?.dueDate ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <CalendarDays className="h-3 w-3" />
              {boardCard.dueDate}
            </span>
          ) : null}
          {boardCard?.checklistTotal ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <CheckSquare className="h-3 w-3" />
              {boardCard.checklistDone}/{boardCard.checklistTotal}
            </span>
          ) : null}
          {combinedAttachments.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <Link2 className="h-3 w-3" />
              {combinedAttachments.length}
            </span>
          ) : null}
          {childCount ? (
            <span className="rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
              To-Do {childCount}
            </span>
          ) : null}
        </div>
        {deliverables.primaryTitle ? (
          <div className="mb-3 truncate text-xs text-muted-foreground">
            {deliverables.primaryTitle}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          {assigneeName ? (
            <Identity name={assigneeName} size="xs" />
          ) : issue.assigneeUserId ? (
            <span className="text-xs text-muted-foreground">{issue.assigneeUserId}</span>
          ) : (
            <span className="text-xs text-muted-foreground">담당자 없음</span>
          )}
        </div>
      </Link>
      {!isOverlay && onUpdateIssue ? (
        <div className="mt-3 space-y-2 border-t border-border pt-2">
          {boardCard?.checklistTotal ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-emerald-500" style={{ width: `${boardCard.checklistProgress}%` }} />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-[11px] text-muted-foreground">
            <span>리스트</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={issue.status}
              aria-label={`${issue.id}-status`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onUpdateIssue(issue.id, { status: event.target.value })}
            >
              {boardLanes.map((lane) => (
                <option key={lane.id} value={lane.id}>{lane.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[11px] text-muted-foreground">
            <span>우선순위</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={issue.priority}
              aria-label={`${issue.id}-priority`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onUpdateIssue(issue.id, { priority: event.target.value })}
            >
              {priorityOptions.map((priority) => (
                <option key={priority} value={priority}>{priorityLabel(priority)}</option>
              ))}
            </select>
          </label>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start px-2 text-xs text-muted-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <X className="mr-1 h-3.5 w-3.5" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
            상세
          </Button>
          {expanded ? (
            <div className="space-y-2 rounded-md border border-border bg-background/70 p-2" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>Due</span>
                  <input
                    type="date"
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={boardCard?.dueDate ?? ""}
                    onChange={(event) => onUpdateBoardCard?.(issue.id, { dueDate: event.target.value || null })}
                  />
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>품질</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={boardCard?.qualityStatus ?? "none"}
                    onChange={(event) => onUpdateBoardCard?.(issue.id, { qualityStatus: event.target.value as Rt2BoardCardMeta["qualityStatus"] })}
                  >
                    <option value="none">none</option>
                    <option value="pending_review">pending</option>
                    <option value="reviewed">reviewed</option>
                    <option value="needs_work">needs work</option>
                  </select>
                </label>
              </div>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                <span>가격 Gold</span>
                <input
                  type="number"
                  min="0"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={boardCard?.priceGold ?? ""}
                  onChange={(event) => onUpdateBoardCard?.(issue.id, { priceGold: event.target.value ? Number(event.target.value) : null })}
                />
              </label>
              <div className="space-y-1">
                {(boardCard?.checklist ?? []).map((item, index, items) => (
                  <div key={item.id} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(event) => onUpdateChecklistItem?.(issue.id, item.id, { checked: event.target.checked })}
                    />
                    <span className={item.checked ? "line-through text-muted-foreground" : ""}>{item.title}</span>
                    <button type="button" className="ml-auto text-[11px] text-muted-foreground" disabled={index === 0} onClick={() => {
                      const next = [...items];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      onReorderChecklist?.(issue.id, next.map((entry) => entry.id));
                    }}>위</button>
                    <button type="button" className="text-[11px] text-muted-foreground" disabled={index === items.length - 1} onClick={() => {
                      const next = [...items];
                      [next[index], next[index + 1]] = [next[index + 1], next[index]];
                      onReorderChecklist?.(issue.id, next.map((entry) => entry.id));
                    }}>아래</button>
                  </div>
                ))}
                <div className="flex gap-1">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    placeholder="Checklist"
                    value={checklistTitle}
                    onChange={(event) => setChecklistTitle(event.target.value)}
                  />
                  <Button type="button" size="sm" className="h-7" onClick={() => {
                    if (!checklistTitle.trim()) return;
                    onAddChecklistItem?.(issue.id, checklistTitle.trim());
                    setChecklistTitle("");
                  }}>추가</Button>
                </div>
              </div>
              {combinedAttachments.length > 0 ? (
                <div className="space-y-1">
                  {combinedAttachments.slice(0, 3).map((attachment) => (
                    <a key={attachment.id} href={attachment.url} className="block truncate rounded-sm bg-muted px-2 py-1 text-xs text-muted-foreground" target="_blank" rel="noreferrer">
                      {attachment.label}
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="grid grid-cols-[1fr_1.3fr_auto] gap-1">
                <input
                  className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  placeholder="첨부명"
                  value={attachmentDraft.label}
                  onChange={(event) => setAttachmentDraft((current) => ({ ...current, label: event.target.value }))}
                />
                <input
                  className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  placeholder="https://"
                  value={attachmentDraft.url}
                  onChange={(event) => setAttachmentDraft((current) => ({ ...current, url: event.target.value }))}
                />
                <Button type="button" size="sm" className="h-7" onClick={() => {
                  if (!attachmentDraft.label.trim() || !attachmentDraft.url.trim()) return;
                  onAddAttachment?.(issue.id, { label: attachmentDraft.label.trim(), url: attachmentDraft.url.trim() });
                  setAttachmentDraft({ label: "", url: "" });
                }}>추가</Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  boardCards,
  onUpdateIssue,
  onUpdateBoardCard,
  onAddChecklistItem,
  onUpdateChecklistItem,
  onReorderChecklist,
  onAddAttachment,
  onCreateTask,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<IssueStatus, Issue[]> = {} as Record<IssueStatus, Issue[]>;
    for (const lane of boardLanes) {
      grouped[lane.id] = [];
    }
    for (const issue of issues) {
      const lane = laneForStatus(issue.status);
      grouped[lane.id].push(issue);
    }
    return grouped;
  }, [issues]);

  const childCountsByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.parentId) continue;
      counts.set(issue.parentId, (counts.get(issue.parentId) ?? 0) + 1);
    }
    return counts;
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
    let targetStatus: IssueStatus | null = null;

    if (isBoardStatus(over.id)) {
      targetStatus = over.id;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = laneForStatus(targetIssue.status).id;
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">RealTycoon2 업무 보드</h2>
          <p className="text-xs text-muted-foreground">
            할 일 / 진행 중 / 완료 3개 리스트에서 카드, 체크리스트, 기한, 첨부, 담당자를 관리합니다.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => onCreateTask?.("todo")}>
          새 작업
        </Button>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {boardLanes.map((lane) => (
          <KanbanColumn
            key={lane.id}
            lane={lane}
            issues={columnIssues[lane.id] ?? []}
            totalCount={issues.length}
            agents={agents}
            liveIssueIds={liveIssueIds}
            boardCards={boardCards}
            childCountsByParent={childCountsByParent}
            onUpdateIssue={onUpdateIssue}
            onUpdateBoardCard={onUpdateBoardCard}
            onAddChecklistItem={onAddChecklistItem}
            onUpdateChecklistItem={onUpdateChecklistItem}
            onReorderChecklist={onReorderChecklist}
            onAddAttachment={onAddAttachment}
            onCreateTask={onCreateTask}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} boardCard={boardCards?.get(activeIssue.id)} childCount={childCountsByParent.get(activeIssue.id) ?? 0} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
