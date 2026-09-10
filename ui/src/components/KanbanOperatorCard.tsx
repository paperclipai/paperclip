import type { CSSProperties, ReactElement } from "react";
import { Link } from "@/lib/router";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Eye,
  GitPullRequest,
  GripVertical,
} from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import type { IssueOverviewPullRequest, IssueOverviewRef } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Identity } from "./Identity";
import { ProjectTile } from "./ProjectTile";
import { IssuesQuicklook } from "./IssuesQuicklook";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { brandChipBadge, issueStatusText } from "../lib/status-colors";
import {
  prDisplayRef,
  prStateLabel,
  type KanbanBlockerModel,
  type KanbanChildSummary,
  type KanbanProjectRef,
} from "./kanbanOverviewModel";

interface KanbanAgent {
  id: string;
  name: string;
}

export interface KanbanOperatorCardProps {
  issue: Issue;
  agents?: KanbanAgent[];
  project?: KanbanProjectRef | null;
  /** Explicitly resolved parent; null means none. Undefined while unresolved. */
  parent?: IssueOverviewRef | null;
  /** Local fallback parent row when the overview cannot name one. */
  parentFallback?: Issue | null;
  /** True when the issue names a parent nothing on screen can resolve. */
  parentUnresolvable?: boolean;
  blocker?: KanbanBlockerModel | null;
  /** Status-blocked with zero blocker detail: render an honest cause-unknown row. */
  blockedWithoutDetail?: boolean;
  pullRequests?: IssueOverviewPullRequest[];
  /** True once the overview projection resolved for this card (even with zero PRs). */
  contextAvailable?: boolean;
  /** True while the overview projection is still loading for this card. */
  contextPending?: boolean;
  children?: KanbanChildSummary;
  ownerUserLabel?: string | null;
  isLive?: boolean;
  subtreeLiveCount?: number;
  isOverlay?: boolean;
  compact?: boolean;
  className?: string;
  /** Board-level drag in flight: suppress hover quicklooks so they never fight a drop. */
  quicklookDisabled?: boolean;
  dragEnabled?: boolean;
  /** Read-only explanation surfaced when dragging is disabled for this card. */
  dragDisabledReason?: string | null;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

type DragHandleAttributes = ReturnType<typeof useSortable>["attributes"];
type DragHandleListeners = ReturnType<typeof useSortable>["listeners"];
type SortableNodeRef = ReturnType<typeof useSortable>["setNodeRef"];

export interface KanbanOperatorCardViewProps extends KanbanOperatorCardProps {
  frameRef: SortableNodeRef;
  frameStyle: CSSProperties;
  dimmed: boolean;
  handleAttributes?: DragHandleAttributes;
  handleListeners?: DragHandleListeners;
}

function issueDetailPath(ref: { id: string; identifier: string | null }): string {
  return `/issues/${ref.identifier ?? ref.id}`;
}

function ChildStatusLabel({ status }: { status: string }): ReactElement {
  return (
    <span className="shrink-0 text-(length:--text-nano) capitalize text-muted-foreground">
      {status.replace(/_/g, " ")}
    </span>
  );
}

const MAX_VISIBLE_PRS = 3;
const MAX_VISIBLE_CHILDREN = 8;

const EXPAND_BUTTON_CLASS =
  "inline-flex shrink-0 items-center rounded-sm px-1 py-0.5 text-(length:--text-nano) font-medium text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function PullRequestChips({
  pullRequests,
  expanded,
  onExpand,
}: {
  pullRequests: IssueOverviewPullRequest[];
  expanded: boolean;
  onExpand: () => void;
}) {
  const visible = expanded ? pullRequests : pullRequests.slice(0, MAX_VISIBLE_PRS);
  const hiddenCount = Math.max(pullRequests.length - visible.length, 0);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <GitPullRequest className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      {visible.map((pr, index) => {
        const label = `${prDisplayRef(pr)} · ${prStateLabel(pr.state)}${pr.stale ? " · stale" : ""}`;
        const title = pr.url
          ? `${label} — open pull request`
          : `${label} — link unavailable`;
        const chip = (
          <Badge
            variant="outline"
            className="max-w-full gap-1 border-border px-1.5 text-(length:--text-nano) font-medium text-muted-foreground"
            title={title}
          >
            {pr.repository ? <span className="min-w-0 max-w-20 truncate">{pr.repository}</span> : null}
            <span className="shrink-0">{pr.number !== null ? `#${pr.number}` : "PR"}</span>
            <span className="shrink-0">{prStateLabel(pr.state)}</span>
            {pr.stale ? <span className="shrink-0">stale</span> : null}
          </Badge>
        );
        // Direct PR links stay siblings of the title link (never nested),
        // so keyboard and touch users get every destination independently.
        return pr.url ? (
          <a
            key={`${pr.url}-${index}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={title}
            aria-label={`Pull request ${label}`}
            className="inline-flex min-w-0 max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {chip}
            <ExternalLink className="ml-0.5 h-3 w-3 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
          </a>
        ) : (
          <span key={`pr-${index}`} title={title} aria-label={`Pull request ${label}`}>
            {chip}
          </span>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`Show ${hiddenCount} more pull requests`}
          onClick={onExpand}
          onPointerDown={(event) => event.stopPropagation()}
          className={EXPAND_BUTTON_CLASS}
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </span>
  );
}

export function KanbanOperatorCardView({
  issue,
  agents,
  project,
  parent,
  parentFallback,
  parentUnresolvable = false,
  blocker,
  blockedWithoutDetail = false,
  pullRequests = [],
  contextAvailable = false,
  contextPending = false,
  children,
  ownerUserLabel,
  isLive,
  subtreeLiveCount = 0,
  isOverlay,
  compact = false,
  className,
  quicklookDisabled = false,
  dragEnabled = true,
  dragDisabledReason,
  expanded = false,
  onToggleExpanded,
  frameRef,
  frameStyle,
  dimmed,
  handleAttributes,
  handleListeners,
}: KanbanOperatorCardViewProps) {
  const agentName = issue.assigneeAgentId
    ? (agents?.find((agent) => agent.id === issue.assigneeAgentId)?.name ?? null)
    : null;
  const ownerLabel = agentName ?? ownerUserLabel ?? null;
  const detailPath = `/issues/${issue.identifier ?? issue.id}`;
  const childCount = children?.childCount ?? 0;
  const completedChildCount = children?.completedChildCount ?? 0;
  const visibleChildren = (children?.refs ?? []).slice(0, MAX_VISIBLE_CHILDREN);
  const hiddenChildCount = Math.max((children?.refs.length ?? 0) - visibleChildren.length, 0);

  // One resolved parent object: overview first, local fallback second. Never
  // dereference a nullable fallback after a nullish overview field.
  const parentDisplay: IssueOverviewRef | null = parent
    ?? (parentFallback
      ? { id: parentFallback.id, identifier: parentFallback.identifier, title: parentFallback.title, status: parentFallback.status }
      : null);
  const parentRefLabel = parentDisplay
    ? (parentDisplay.identifier ?? parentDisplay.id.slice(0, 8))
    : null;

  const extraBlockers = (blocker?.issues ?? []).slice(1);
  const extraBlockerCount = extraBlockers.length;
  const firstBlocker = blocker?.issues[0] ?? null;

  return (
    <Card
      ref={frameRef}
      style={frameStyle}
      data-testid="kanban-card"
      data-issue-id={issue.id}
      title={!dragEnabled && dragDisabledReason ? dragDisabledReason : undefined}
      className={cn(
        "block transition-shadow",
        dimmed ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      <div className={cn("flex items-start gap-1.5", compact ? "mb-1" : "mb-1.5")}>
        {dragEnabled && handleAttributes && handleListeners ? (
          <button
            type="button"
            {...handleAttributes}
            {...handleListeners}
            aria-label={`Drag ${issue.identifier ?? "task"} to another stage`}
            title="Drag to move between stages"
            className="shrink-0 cursor-grab rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>
        {!quicklookDisabled && !isOverlay ? (
          <IssuesQuicklook issue={issue}>
            <button
              type="button"
              aria-label={`Inspect ${issue.identifier ?? "task"}`}
              title="Inspect task without leaving the board"
              onPointerDown={(event) => event.stopPropagation()}
              className="ml-auto shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </IssuesQuicklook>
        ) : null}
        {isSuccessfulRunHandoffRequired(issue) ? (
          <Badge
            variant="outline"
            className={cn("px-1.5 text-(length:--text-nano)", brandChipBadge.amber)}
            title="This task needs a next step"
            aria-label="Needs next step"
          >
            <AlertTriangle className="h-3 w-3" />
            Next step
          </Badge>
        ) : null}
        {isLive && (
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium", issueStatusText.in_progress)}>
            <span className="relative flex h-2 w-2">
              <span
                className="absolute inline-flex h-full w-full animate-pulse rounded-full"
                style={{ backgroundColor: "var(--status-task-in_progress)", opacity: 0.75 }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ backgroundColor: "var(--status-task-in_progress)" }}
              />
            </span>
            {compact ? "Live" : null}
          </span>
        )}
        {!isLive && subtreeLiveCount > 0 && (
          <Badge
            variant="outline"
            className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
            title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
            {subtreeLiveCount} live below
          </Badge>
        )}
      </div>

      <Link
        to={detailPath}
        issuePrefetch={issue}
        disableIssueQuicklook={quicklookDisabled || dimmed}
        className="block rounded-sm text-inherit no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          if (dimmed) event.preventDefault();
        }}
      >
        <p
          className={cn(compact ? "mb-1.5 text-xs" : "mb-2 text-sm", "leading-snug line-clamp-2")}
          title={issue.title}
        >
          {issue.title}
        </p>
      </Link>

      <div className={cn("flex min-w-0 flex-col", compact ? "gap-1" : "gap-1.5")}>
        <span
          className="flex min-w-0 items-center gap-1.5 text-(length:--text-nano) text-muted-foreground"
          data-testid="kanban-card-project"
          title={project ? `Project: ${project.name}` : "No project"}
        >
          {project ? (
            <>
              <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="xs" />
              <span className="truncate font-medium">{project.name}</span>
            </>
          ) : (
            <span className="truncate">No project</span>
          )}
        </span>

        {parentDisplay && parentRefLabel ? (
          <span
            className="flex min-w-0 items-center gap-1 text-(length:--text-nano) text-muted-foreground"
            data-testid="kanban-card-parent"
          >
            <span className="shrink-0">Parent</span>
            <Link
              to={issueDetailPath(parentDisplay)}
              disableIssueQuicklook={quicklookDisabled || dimmed}
              className="min-w-0 flex-1 truncate font-medium text-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground"
              title={`${parentRefLabel}: ${parentDisplay.title}`}
            >
              {parentRefLabel} · {parentDisplay.title}
            </Link>
          </span>
        ) : parentUnresolvable ? (
          <span
            className="truncate text-(length:--text-nano) text-muted-foreground"
            data-testid="kanban-card-parent"
            title="This task names a parent that is not visible with the current filters"
          >
            Parent unavailable
          </span>
        ) : null}

        {blocker ? (
          <div
            data-testid="kanban-card-blocker"
            className={cn("rounded-md border px-2 py-1.5", brandChipBadge.red)}
          >
            <p className="flex min-w-0 items-center gap-1 text-(length:--text-nano) font-medium">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              {firstBlocker ? (
                <>
                  <span className="shrink-0">Blocked by</span>
                  <Link
                    to={issueDetailPath(firstBlocker)}
                    disableIssueQuicklook={quicklookDisabled || dimmed}
                    className="min-w-0 flex-1 truncate underline underline-offset-2"
                    title={firstBlocker.title}
                  >
                    {firstBlocker.identifier ?? firstBlocker.id.slice(0, 8)}
                  </Link>
                  {extraBlockerCount > 0 && !expanded ? (
                    <button
                      type="button"
                      aria-expanded={false}
                      aria-label={`Show ${extraBlockerCount} more blockers`}
                      onClick={() => onToggleExpanded?.()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className={cn(EXPAND_BUTTON_CLASS, "px-0.5")}
                    >
                      +{extraBlockerCount}
                    </button>
                  ) : null}
                </>
              ) : (
                <span>Blocked</span>
              )}
            </p>
            {expanded && extraBlockers.length > 0 ? (
              <span className="mt-1 flex min-w-0 flex-col gap-0.5">
                {extraBlockers.map((entry) => (
                  <Link
                    key={entry.id}
                    to={issueDetailPath(entry)}
                    disableIssueQuicklook={quicklookDisabled || dimmed}
                    className="min-w-0 truncate text-(length:--text-nano) underline decoration-dotted underline-offset-2"
                    title={`${entry.identifier ?? entry.id.slice(0, 8)}: ${entry.title}`}
                  >
                    {entry.identifier ?? entry.id.slice(0, 8)} · {entry.title}
                  </Link>
                ))}
              </span>
            ) : null}
            {blocker.message ? (
              <p
                className="mt-0.5 line-clamp-2 text-(length:--text-nano) leading-snug opacity-90"
                title={blocker.message}
              >
                {blocker.message}
              </p>
            ) : null}
            {blocker.ownerLabel || blocker.nextAction ? (
              <p className="mt-0.5 truncate text-(length:--text-nano) text-muted-foreground">
                {[blocker.ownerLabel, blocker.nextAction].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        ) : blockedWithoutDetail ? (
          <p
            data-testid="kanban-card-blocker"
            className="truncate text-(length:--text-nano) text-muted-foreground"
            title="Blocked, but no cause is recorded yet"
          >
            Blocked · cause not recorded
          </p>
        ) : null}

        {pullRequests.length > 0 ? (
          <span data-testid="kanban-card-pr" className="flex min-w-0">
            <PullRequestChips
              pullRequests={pullRequests}
              expanded={expanded}
              onExpand={() => onToggleExpanded?.()}
            />
          </span>
        ) : contextPending ? (
          <span
            data-testid="kanban-card-pr-state"
            className="truncate text-(length:--text-nano) text-muted-foreground"
          >
            Loading PR context…
          </span>
        ) : contextAvailable ? (
          <span
            data-testid="kanban-card-pr-state"
            className="truncate text-(length:--text-nano) text-muted-foreground"
          >
            No linked PR
          </span>
        ) : (
          <span
            data-testid="kanban-card-pr-state"
            className="truncate text-(length:--text-nano) text-muted-foreground"
            title="Task context could not be loaded for this board"
          >
            PR context unavailable
          </span>
        )}

        {ownerLabel || childCount > 0 ? (
          <span className="flex min-w-0 items-center gap-1.5 text-(length:--text-nano) text-muted-foreground">
            {ownerLabel ? (
              agentName ? (
                <Identity name={agentName} size="xs" />
              ) : (
                <span className="min-w-0 flex-1 truncate" title={`Owner: ${ownerLabel}`}>
                  {ownerLabel}
                </span>
              )
            ) : null}
            {childCount > 0 ? (
              <button
                type="button"
                data-testid="kanban-card-children-toggle"
                aria-expanded={expanded}
                aria-label={expanded
                  ? `Hide ${childCount} sub-tasks`
                  : `Show ${childCount} sub-tasks, ${completedChildCount} done`}
                onClick={() => onToggleExpanded?.()}
                onPointerDown={(event) => event.stopPropagation()}
                className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight
                  className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
                  aria-hidden="true"
                />
                {completedChildCount}/{childCount} subtasks
              </button>
            ) : null}
          </span>
        ) : null}

        {expanded && childCount > 0 ? (
          <span className="flex min-w-0 flex-col gap-0.5 border-l border-border pl-2">
            {visibleChildren.map((child) => (
              <span key={child.id} className="flex min-w-0 items-center gap-1.5">
                <Link
                  to={issueDetailPath(child)}
                  disableIssueQuicklook={quicklookDisabled || dimmed}
                  className="min-w-0 flex-1 truncate text-(length:--text-nano) text-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground"
                  title={`${child.identifier ?? child.id.slice(0, 8)}: ${child.title}`}
                >
                  {child.identifier ?? child.id.slice(0, 8)} · {child.title}
                </Link>
                <ChildStatusLabel status={child.status} />
              </span>
            ))}
            {hiddenChildCount > 0 ? (
              <Link
                to={detailPath}
                disableIssueQuicklook={quicklookDisabled || dimmed}
                className="text-(length:--text-nano) text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                aria-label={`View all ${childCount} sub-tasks in task detail`}
              >
                +{hiddenChildCount} more — view in task detail
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function KanbanOperatorCard(props: KanbanOperatorCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.issue.id, data: { issue: props.issue }, disabled: !props.dragEnabled });

  return (
    <KanbanOperatorCardView
      {...props}
      frameRef={setNodeRef}
      frameStyle={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      dimmed={isDragging && !props.isOverlay}
      handleAttributes={props.dragEnabled ? attributes : undefined}
      handleListeners={props.dragEnabled ? listeners : undefined}
    />
  );
}
