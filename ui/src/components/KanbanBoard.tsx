import { useMemo, useState } from "react";
import type { ReactNode } from "react";
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
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AlertTriangle } from "lucide-react";
import { StatusIcon, isControllerOwnedIssueStatus } from "./StatusIcon";
import { ProjectTile } from "./ProjectTile";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import type { IssueOverview } from "@paperclipai/shared";
import { useIssueOverviews } from "../hooks/useIssueOverviews";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KanbanOperatorCard, KanbanOperatorCardView } from "./KanbanOperatorCard";
import { issueStatusText } from "../lib/status-colors";
import {
  applyBoardScope,
  groupIssuesByProject,
  isCardBlocked,
  resolveBlockerModel,
  resolveCardPhase,
  resolveCardProject,
  resolveCardPullRequests,
  resolveChildSummary,
  resolveParentRef,
  type KanbanBoardScope,
  type KanbanPhase,
  type KanbanProjectGroup,
  type KanbanProjectRef,
} from "./kanbanOverviewModel";

export type { KanbanBoardScope };

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

/**
 * Board-only lane sequence. `blocked` is deliberately absent: blocked tasks
 * stay in their actual projected phase lane with their blocker called out on
 * the card. The global `ISSUE_STATUSES` vocabulary is untouched.
 */
export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "ready_to_merge",
  "merging",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

const defaultKanbanColumnTone = {
  rail: "border-border bg-muted/20",
  railOver: "bg-accent/50 ring-1 ring-primary/20",
  header: "text-muted-foreground",
  count: "text-muted-foreground/60",
  body: "bg-muted/20",
  bodyOver: "bg-accent/40",
  card: "",
};

// Every column carries a status-hued tint (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
export const kanbanColumnTones: Partial<Record<IssueStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "border-border bg-muted/30",
    railOver: "bg-muted/50 ring-1 ring-neutral-400/25",
    header: "text-muted-foreground",
    count: "text-muted-foreground/60",
    body: "bg-muted/30 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/50 ring-1 ring-inset ring-neutral-400/25",
    card: "",
  },
  todo: {
    rail: "border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20",
    railOver: "bg-amber-100/70 ring-1 ring-amber-500/25 dark:bg-amber-950/35",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700/65 dark:text-amber-300/65",
    body: "bg-amber-50/45 ring-1 ring-inset ring-amber-500/15 dark:bg-amber-950/15",
    bodyOver: "bg-amber-100/70 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-950/30",
    card: "",
  },
  in_progress: {
    rail: "border-blue-500/25 bg-blue-50/60 dark:bg-blue-950/20",
    railOver: "bg-blue-100/70 ring-1 ring-blue-500/25 dark:bg-blue-950/35",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700/65 dark:text-blue-300/65",
    body: "bg-blue-50/45 ring-1 ring-inset ring-blue-500/15 dark:bg-blue-950/15",
    bodyOver: "bg-blue-100/70 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-950/30",
    card: "",
  },
  blocked: {
    rail: "border-red-500/25 bg-red-50/60 dark:bg-red-950/20",
    railOver: "bg-red-100/70 ring-1 ring-red-500/25 dark:bg-red-950/35",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700/65 dark:text-red-300/65",
    body: "bg-red-50/45 ring-1 ring-inset ring-red-500/15 dark:bg-red-950/15",
    bodyOver: "bg-red-100/70 ring-1 ring-inset ring-red-500/25 dark:bg-red-950/30",
    card: "",
  },
  in_review: {
    rail: "border-violet-500/25 bg-violet-50/60 dark:bg-violet-950/20",
    railOver: "bg-violet-100/70 ring-1 ring-violet-500/25 dark:bg-violet-950/35",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700/65 dark:text-violet-300/65",
    body: "bg-violet-50/45 ring-1 ring-inset ring-violet-500/15 dark:bg-violet-950/15",
    bodyOver: "bg-violet-100/70 ring-1 ring-inset ring-violet-500/25 dark:bg-violet-950/30",
    card: "",
  },
  ready_to_merge: {
    rail: "border-teal-500/25 bg-teal-50/60 dark:bg-teal-950/20",
    railOver: "bg-teal-100/70 ring-1 ring-teal-500/25 dark:bg-teal-950/35",
    header: "text-teal-700 dark:text-teal-300",
    count: "text-teal-700/65 dark:text-teal-300/65",
    body: "bg-teal-50/45 ring-1 ring-inset ring-teal-500/15 dark:bg-teal-950/15",
    bodyOver: "bg-teal-100/70 ring-1 ring-inset ring-teal-500/25 dark:bg-teal-950/30",
    card: "",
  },
  merging: {
    rail: "border-indigo-500/25 bg-indigo-50/60 dark:bg-indigo-950/20",
    railOver: "bg-indigo-100/70 ring-1 ring-indigo-500/25 dark:bg-indigo-950/35",
    header: "text-indigo-700 dark:text-indigo-300",
    count: "text-indigo-700/65 dark:text-indigo-300/65",
    body: "bg-indigo-50/45 ring-1 ring-inset ring-indigo-500/15 dark:bg-indigo-950/15",
    bodyOver: "bg-indigo-100/70 ring-1 ring-inset ring-indigo-500/25 dark:bg-indigo-950/30",
    card: "",
  },
  done: {
    rail: "border-green-500/25 bg-green-50/60 dark:bg-green-950/20",
    railOver: "bg-green-100/70 ring-1 ring-green-500/25 dark:bg-green-950/35",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700/65 dark:text-green-300/65",
    body: "bg-green-50/45 ring-1 ring-inset ring-green-500/15 dark:bg-green-950/15",
    bodyOver: "bg-green-100/70 ring-1 ring-inset ring-green-500/25 dark:bg-green-950/30",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-muted-foreground/80",
    count: "text-muted-foreground/50",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: IssueStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Controller-owned lanes render for visibility but are never valid drop
 * targets: only the delivery controller may move tasks into ready_to_merge
 * or merging. Lanes stay registered for hit-testing; the drop resolver rejects
 * them so a drag cannot fall through to an adjacent writable lane.
 *
 * There is no `blocked` lane on this board: dropping onto a blocked card
 * resolves to that card's projected phase (never `blocked`), and a `blocked`
 * lane id is rejected outright.
 */
function parseLaneStage(overId: string): string {
  // Swimlane droppables qualify the stage (`<groupKey>:<stage>`); card ids
  // never contain a colon, so the suffix is unambiguous.
  const separator = overId.lastIndexOf(":");
  return separator >= 0 ? overId.slice(separator + 1) : overId;
}

export function resolveKanbanTargetStatus(
  overId: string,
  issues: Issue[],
  overviewsById?: ReadonlyMap<string, IssueOverview>,
): IssueStatus | null {
  const stage = parseLaneStage(overId);
  if (stage === "blocked") return null;
  if (isControllerOwnedIssueStatus(stage)) {
    return null;
  }
  if ((boardStatuses as readonly string[]).includes(stage)) {
    return stage as IssueStatus;
  }
  const overIssue = issues.find((issue) => issue.id === overId);
  if (!overIssue) return null;
  if (isControllerOwnedIssueStatus(overIssue.status)) {
    return null;
  }
  const overview = overviewsById?.get(overIssue.id);
  if (overview) {
    // A projected controller-owned phase is still controller-owned, even
    // when the stored status reads `blocked`.
    if (!overview.phase || isControllerOwnedIssueStatus(overview.phase)) return null;
    return overview.phase;
  }
  if (overIssue.status === "blocked") return null;
  return overIssue.status;
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  /** Company scope for the issue-overviews read contract. */
  companyId?: string | null;
  projects?: KanbanProjectRef[];
  /** Company member userId -> display label, for card owner rows. */
  ownerUserLabels?: ReadonlyMap<string, string>;
  /** Project swimlanes group every lane; off renders one flat lane set. */
  swimlanes?: boolean;
  /** `outcomes` shows family heads only; `all` shows every task. */
  scope?: KanbanBoardScope;
}

export interface KanbanPhaseSplit {
  lanes: Record<KanbanPhase, Issue[]>;
  unknown: Issue[];
}

export function splitIssuesByPhase(
  issues: Issue[],
  overviewsById: ReadonlyMap<string, IssueOverview> | undefined,
): KanbanPhaseSplit {
  const lanes = {} as Record<KanbanPhase, Issue[]>;
  for (const status of boardStatuses) {
    lanes[status] = [];
  }
  const unknown: Issue[] = [];
  for (const issue of issues) {
    const phase = resolveCardPhase(issue, overviewsById?.get(issue.id));
    if (phase && lanes[phase]) {
      lanes[phase].push(issue);
    } else {
      unknown.push(issue);
    }
  }
  return { lanes, unknown };
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  droppableId,
  issues,
  collapsed = false,
  visibleCount,
  revealIncrement,
  onShowMore,
  renderCard,
}: {
  status: KanbanPhase;
  /** Swimlanes qualify the id (`<groupKey>:<stage>`); the resolver parses the stage back out. */
  droppableId: string;
  issues: Issue[];
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  onShowMore: () => void;
  renderCard: (issue: Issue) => ReactNode;
}) {
  const controllerOwned = isControllerOwnedIssueStatus(status);
  const controllerTitle = "Managed by the delivery controller. Use the task's Delivery tab for details.";
  // Keep read-only lanes in hit-testing so a drag cannot fall through to an
  // adjacent writable lane. resolveKanbanTargetStatus rejects their drops.
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  const isEmpty = issues.length === 0;
  const visibleIssues = collapsed ? [] : issues.slice(0, visibleCount);
  const hiddenCount = Math.max(issues.length - visibleIssues.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);
  const tone = getKanbanColumnTone(status);

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        data-kanban-lane={status}
        className={cn(
          "flex min-h-(--sz-220px) w-(--sz-52px) shrink-0 flex-col items-center rounded-md border px-1.5 py-2 transition-colors",
          tone.rail,
          isOver && !controllerOwned && tone.railOver,
        )}
        title={controllerOwned ? controllerTitle : `${statusLabel(status)}: ${issues.length}`}
      >
        <StatusIcon status={status} />
        <span className={cn("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <Badge variant="ghost" className={cn("mt-auto bg-background px-1.5 text-(length:--text-nano) tabular-nums", tone.header)}>
          {issues.length}
        </Badge>
      </div>
    );
  }

  // Empty lanes stay droppable via a compact dashed well. The lane keeps full
  // stage width so swimlane columns align across projects; flat boards
  // collapse empty stages to rails through the collapsed flag instead.
  if (isEmpty) {
    return (
      <div className="flex flex-col shrink-0 min-w-(--sz-260px) w-(--sz-260px)">
        <div className="flex items-center gap-2 px-3 py-2 mb-1" title={controllerOwned ? controllerTitle : undefined}>
          <StatusIcon status={status} />
          <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
            {statusLabel(status)}
          </span>
          {controllerOwned ? (
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
              Controller
            </span>
          ) : null}
          <span className={cn("ml-auto text-xs tabular-nums", tone.count)}>
            0
          </span>
        </div>
        <div
          ref={setNodeRef}
          data-kanban-lane={status}
          className={cn(
            "rounded-md border border-dashed border-border/80 px-2 py-3 text-center text-(length:--text-nano) text-muted-foreground transition-colors",
            isOver && !controllerOwned ? tone.bodyOver : "bg-transparent",
          )}
        >
          <SortableContext items={[]} strategy={verticalListSortingStrategy}>
            <span>Empty</span>
          </SortableContext>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col shrink-0 min-w-(--sz-260px) w-(--sz-260px)">
      <div className="flex items-center gap-2 px-3 py-2 mb-1" title={controllerOwned ? controllerTitle : undefined}>
        <StatusIcon status={status} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        {controllerOwned ? (
          <span className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
            Controller
          </span>
        ) : null}
        <span className={cn("ml-auto text-xs tabular-nums", tone.count)}>
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        data-kanban-lane={status}
        className={cn(
          "flex-1 min-h-(--sz-120px) rounded-md p-2 space-y-1 transition-colors",
          isOver && !controllerOwned ? tone.bodyOver : tone.body,
        )}
      >
        {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
        <SortableContext
          items={visibleIssues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {visibleIssues.map((issue) => renderCard(issue))}
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
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visibleIssues.length} of {issues.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}
/* ── Project swimlanes ── */

// One shared horizontal scroll for every swimlane, with stage widths decided
// globally per status (collapsed-by-pref or empty-everywhere → rail in all
// groups), so columns align across projects instead of scrolling apart.
function SwimlaneBoard({
  groups,
  overviewsById,
  collapsedStatusSet,
  renderLaneRow,
}: {
  groups: KanbanProjectGroup[];
  overviewsById: ReadonlyMap<string, IssueOverview> | undefined;
  collapsedStatusSet: ReadonlySet<string>;
  renderLaneRow: (
    lanes: Record<KanbanPhase, Issue[]>,
    keyPrefix: string,
    isCollapsed: (status: KanbanPhase) => boolean,
  ) => ReactNode;
}) {
  const splits = groups.map((group) => ({
    group,
    lanes: splitIssuesByPhase(group.items, overviewsById).lanes,
  }));
  const stageEmptyEverywhere = (status: KanbanPhase) =>
    splits.every(({ lanes }) => (lanes[status] ?? []).length === 0);

  return (
    <div className="overflow-x-auto pb-4 -mx-2 px-2">
      <div className="space-y-5">
        {splits.map(({ group, lanes }) => {
          const groupBlocked = group.items.filter((issue) =>
            isCardBlocked(issue, overviewsById?.get(issue.id)),
          ).length;
          return (
            <section key={group.key} aria-label={`${group.label} swimlane`}>
              <div className="mb-1 flex items-center gap-2 px-1">
                {group.projectId ? (
                  <ProjectTile color={group.color ?? null} icon={group.icon ?? null} size="xs" />
                ) : null}
                <h3 className="text-xs font-semibold">{group.label}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.items.length}
                </span>
                {groupBlocked > 0 ? (
                  <span className={cn("text-(length:--text-nano) font-medium", issueStatusText.blocked)}>
                    {groupBlocked} blocked
                  </span>
                ) : null}
              </div>
              {renderLaneRow(
                lanes,
                group.key,
                (status) => collapsedStatusSet.has(status) || stageEmptyEverywhere(status),
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}


/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  onUpdateIssue,
  companyId,
  projects,
  ownerUserLabels,
  swimlanes = false,
  scope = "all",
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByStatus = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Overview read contract (Data-owned hook): batched, company-scoped,
  // freshness is record observation, never a new forge check.
  const issueIds = useMemo(() => {
    const unique = new Set<string>();
    for (const issue of issues) unique.add(issue.id);
    return [...unique].sort();
  }, [issues]);
  const {
    byId: overviewsById,
    isPending: overviewsPending,
    error: overviewsError,
    refetch: refetchOverviews,
  } = useIssueOverviews(companyId, issueIds);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const projectsById = useMemo(() => {
    const map = new Map<string, KanbanProjectRef>();
    for (const project of projects ?? []) {
      map.set(project.id, {
        id: project.id,
        name: project.name,
        color: project.color ?? null,
        icon: project.icon ?? null,
      });
    }
    return map;
  }, [projects]);

  const childrenByParentId = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of issues) {
      if (!issue.parentId) continue;
      const siblings = map.get(issue.parentId);
      if (siblings) siblings.push(issue);
      else map.set(issue.parentId, [issue]);
    }
    return map;
  }, [issues]);

  const scopedIssues = useMemo(
    () => applyBoardScope(issues, scope, overviewsById),
    [issues, scope, overviewsById],
  );

  const { lanes: columnIssues, unknown: unknownIssues } = useMemo(
    () => splitIssuesByPhase(scopedIssues, overviewsById),
    [scopedIssues, overviewsById],
  );

  const projectGroups = useMemo(() => {
    if (!swimlanes) return null;
    const phased = scopedIssues.filter(
      (issue) => resolveCardPhase(issue, overviewsById?.get(issue.id)) != null,
    );
    return groupIssuesByProject(phased, (issue) =>
      resolveCardProject(issue, overviewsById?.get(issue.id), projectsById),
    );
  }, [swimlanes, scopedIssues, overviewsById, projectsById]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function cardPropsFor(issue: Issue, forceCompact = false) {
    const overview = overviewsById?.get(issue.id);
    const phase = resolveCardPhase(issue, overview);
    const blocked = isCardBlocked(issue, overview);
    const blocker = blocked ? resolveBlockerModel(issue, overview) : null;
    const parentFallback = issue.parentId ? (issueById.get(issue.parentId) ?? null) : null;
    // Blocked and phase-unknown cards are drag-disabled with an explanation
    // instead of a draggable no-op: no false affordance.
    const draggable = !blocked && phase != null;
    return {
      issue,
      agents,
      project: resolveCardProject(issue, overview, projectsById),
      parent: resolveParentRef(overview),
      parentFallback,
      parentUnresolvable: Boolean(issue.parentId && !resolveParentRef(overview) && !parentFallback),
      blocker,
      blockedWithoutDetail: blocked && !blocker,
      pullRequests: resolveCardPullRequests(overview),
      contextAvailable: overview !== undefined,
      contextPending: overview === undefined && overviewsPending,
      children: resolveChildSummary(issue, overview, childrenByParentId.get(issue.id) ?? []),
      ownerUserLabel: issue.assigneeUserId ? (ownerUserLabels?.get(issue.assigneeUserId) ?? null) : null,
      isLive: liveIssueIds?.has(issue.id),
      subtreeLiveCount: subtreeLiveCounts?.get(issue.id) ?? 0,
      compact: forceCompact || compactCards,
      quicklookDisabled: activeId !== null,
      dragEnabled: draggable,
      dragDisabledReason: blocked
        ? "Blocked tasks stay in their stage until unblocked — unblock from task detail"
        : phase == null
          ? "Tasks without a recorded stage can't be dragged — triage first"
          : null,
      expanded: expandedIds.has(issue.id),
      onToggleExpanded: () => toggleExpanded(issue.id),
    };
  }

  function renderCard(issue: Issue, forceCompact = false): ReactNode {
    return <KanbanOperatorCard key={issue.id} {...cardPropsFor(issue, forceCompact)} />;
  }

  function renderOverlayCard(issue: Issue): ReactNode {
    // The overlay renders the pure view: registering a second sortable for
    // the same id would corrupt the drag session.
    const visualProps = cardPropsFor(issue);
    return (
      <KanbanOperatorCardView
        {...visualProps}
        isOverlay
        dragEnabled={false}
        quicklookDisabled
        frameRef={() => undefined}
        frameStyle={{}}
        dimmed={false}
      />
    );
  }

  function showMoreFor(status: KanbanPhase) {
    setVisibleState((current) => {
      const counts = current.paginationKey === paginationKey ? current.counts : {};
      return {
        paginationKey,
        counts: {
          ...counts,
          [status]: (counts[status] ?? initialVisibleCount) + revealIncrement,
        },
      };
    });
  }

  function renderLaneRow(
    lanes: Record<KanbanPhase, Issue[]>,
    keyPrefix: string,
    isCollapsed: (status: KanbanPhase) => boolean,
  ) {
    return (
      <div className="flex gap-3">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={`${keyPrefix}:${status}`}
            status={status}
            droppableId={`${keyPrefix}:${status}`}
            issues={lanes[status] ?? []}
            collapsed={isCollapsed(status)}
            visibleCount={visibleCountByStatus[status] ?? initialVisibleCount}
            revealIncrement={revealIncrement}
            onShowMore={() => showMoreFor(status)}
            renderCard={(issue) => renderCard(issue)}
          />
        ))}
      </div>
    );
  }

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

    // The "over" target may be a lane id or another card's id. Blocked cards
    // resolve to their projected phase, never to a `blocked` lane.
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues, overviewsById);
    if (!targetStatus) return;

    const overview = overviewsById?.get(issueId);
    const currentPhase = overview
      ? overview.phase
      : issue.status === "blocked" ? null : issue.status;
    if (targetStatus === currentPhase) return;

    // Never silently clear blockage: a lane drop must not move a blocked card
    // off its blocked state. Unblocking stays an explicit status action.
    if (overview ? overview.blocked : issue.status === "blocked") return;

    onUpdateIssue(issueId, { status: targetStatus });
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  const totalVisibleCards = scopedIssues.length;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {overviewsError ? (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={overviewsError.message}>
            Task context unavailable — showing basic details. {overviewsError.message}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={() => refetchOverviews()}>
            Retry
          </Button>
        </div>
      ) : overviewsPending && issues.length > 0 ? (
        <p className="mb-3 text-xs text-muted-foreground" aria-live="polite">
          Loading task context…
        </p>
      ) : null}

      {totalVisibleCards === 0 && unknownIssues.length === 0 ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {scope === "outcomes"
            ? "No outcome tasks in this view. Switch to All tasks to see every subtask."
            : "No tasks in this view."}
        </p>
      ) : null}

      {projectGroups ? (
        <SwimlaneBoard
          groups={projectGroups}
          overviewsById={overviewsById}
          collapsedStatusSet={collapsedStatusSet}
          renderLaneRow={renderLaneRow}
        />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
          {renderLaneRow(columnIssues, "board", (status) =>
            collapsedStatusSet.has(status) || (columnIssues[status] ?? []).length === 0,
          )}
        </div>
      )}

      {unknownIssues.length > 0 ? (
        <section
          aria-label="Stage not recorded"
          data-kanban-unknown="true"
          className="mt-1 rounded-md border border-dashed border-border p-3"
        >
          <div className="mb-1 flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Stage not recorded
            </h3>
            <Badge variant="ghost" className="bg-background px-1.5 text-(length:--text-nano) tabular-nums text-muted-foreground">
              {unknownIssues.length}
            </Badge>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            These tasks have no recorded stage yet, so they wait here instead of a
            default lane. Triage them to place them on the board.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {unknownIssues.map((issue) => renderCard(issue, true))}
          </div>
        </section>
      ) : null}

      <DragOverlay>
        {activeIssue ? renderOverlayCard(activeIssue) : null}
      </DragOverlay>
    </DndContext>
  );
}
