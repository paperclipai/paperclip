import { requiresExecutionReconciliation } from "@paperclipai/shared";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { ExternalObjectSummary, Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Archive, Flag, CircleAlert } from "lucide-react";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
} from "../lib/recovery-display";
import {
  formatRecoveryLineageSummary,
  readRecoveryRetryLineage,
  type RecoveryLivenessContext,
} from "../lib/recovery-lineage";
import { StatusIcon, getStatusIconLabel } from "./StatusIcon";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TaskRowColumnCells, useTaskListColumns, type TaskRowColumnValues } from "./TaskListColumns";
import { CellMarquee, HoveredCellContext, useCellMarqueeHover } from "./CellMarquee";

export type IssueRowUnreadState = "hidden" | "visible" | "fading";
export type IssueRowPresentation = "legacy" | "task";
export type IssueRowAppearance = "default" | "refreshed";
export type IssueRowDensity = "comfortable" | "compact";

export interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  selected?: boolean;
  /** Opt-in canonical collection layout. Legacy remains the default until each surface migrates. */
  presentation?: IssueRowPresentation;
  /** Reviewed in Storybook before adoption; only applies to the canonical task presentation. */
  appearance?: IssueRowAppearance;
  /** Refreshed task rows share their anatomy at either density. */
  density?: IssueRowDensity;
  /** Reserve collection geometry while optional diagnostics arrive. */
  stableLayout?: boolean;
  /** Opt-in complete column contract for refreshed task lists. */
  columnValues?: TaskRowColumnValues;
  /** Interactive disclosure or selection control before the canonical status glyph. */
  leadingControl?: ReactNode;
  /** Optional status override; defaults to the task's shared StatusIcon. */
  statusSlot?: ReactNode;
  /** Stable metadata slot before the task's optional collection columns. */
  metadata?: ReactNode;
  /** Stable interactive action slot before the identifier and timestamp columns. */
  actions?: ReactNode;
  /** Controls the canonical trailing identifier without affecting legacy layouts. */
  showIdentifier?: boolean;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  /** Compact mobile timestamp beside the title in canonical task lists. */
  mobileTitleMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  /**
   * Optional pre-fetched external-object summary. Renders a compact severity
   * marker before the rest of `desktopTrailing` on desktop only.
   */
  externalObjectSummary?: ExternalObjectSummary | null;
  trailingMeta?: ReactNode;
  titleSuffix?: ReactNode;
  titleClassName?: string;
  checklistStepNumber?: number | string | null;
  checklistCurrentStep?: boolean;
  checklistDependencyChips?: ReactNode;
  checklistRowId?: string;
  unreadState?: IssueRowUnreadState | null;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
  /** Pointer entered the row (used by list keyboard nav to track hover). */
  onMouseEnter?: () => void;
  /** Ancestor levels; renders that many vertical tree-guide slots (desktop). */
  treeGuides?: number;
  /**
   * This nested row has its own collapse chevron aligned with the innermost
   * guide. Breaks the guide line there so the chevron is not crossed out.
   */
  chevronInGuide?: boolean;
  /** Legacy-only opt in to a bottom divider; canonical task rows stay divider-free. */
  showDivider?: boolean;
}

export function InboxArchiveButton({
  onArchive,
  disabled,
  compact = false,
}: {
  onArchive: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      data-slot="icon-button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onArchive();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onArchive();
      }}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30",
        compact ? "h-5 py-0" : "py-1",
      )}
      aria-label="Archive"
    >
      <Archive className="h-3.5 w-3.5" />
      Archive
    </button>
  );
}

export function IssueRow({
  issue,
  issueLinkState,
  selected = false,
  presentation = "legacy",
  appearance = "default",
  density = "comfortable",
  stableLayout = false,
  columnValues,
  leadingControl,
  statusSlot,
  metadata,
  actions,
  showIdentifier = true,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  mobileTitleMeta,
  desktopTrailing,
  externalObjectSummary,
  trailingMeta,
  titleSuffix,
  titleClassName,
  checklistStepNumber = null,
  checklistCurrentStep = false,
  checklistDependencyChips,
  checklistRowId,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
  onMouseEnter,
  treeGuides = 0,
  chevronInGuide = false,
  showDivider = false,
}: IssueRowProps) {
  const visibleColumns = useTaskListColumns();
  const { hoveredCell, onMouseMove: handleCellHover, clearHoveredCell } = useCellMarqueeHover();
  const [titleFocused, setTitleFocused] = useState(false);

  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  // Refreshed task rows communicate unread state through title typography alone.
  // Existing presentations retain their unread control and its reserved space.
  const showUnreadSlot = unreadState != null && !(presentation === "task" && appearance === "refreshed");
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";
  const unreadDotButton = (
    <button
      type="button"
      data-slot="icon-button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMarkRead?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onMarkRead?.();
        }
      }}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
        selected ? "hover:bg-muted/80" : "hover:bg-blue-500/20",
      )}
      aria-label="Mark as read"
    >
      <span
        className={cn(
          "block h-2 w-2 rounded-full transition-opacity duration-300",
          selected ? "bg-muted-foreground/70" : "bg-blue-600 dark:bg-blue-400",
          unreadState === "fading" ? "opacity-0" : "opacity-100",
        )}
      />
    </button>
  );
  const selectedStatusClass = selected ? "!text-muted-foreground !border-muted-foreground" : undefined;
  const detailState = withIssueDetailHeaderSeed(issueLinkState, issue);
  const hasChecklistStep = checklistStepNumber !== null;
  const checklistStep = hasChecklistStep ? (
    <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
      {checklistStepNumber}.
    </span>
  ) : null;
  const recoveryAction = issue.activeRecoveryAction ?? null;
  // The row already carries the issue's own scheduled retry, so the chip can tell a retry the
  // scheduler is actually running from one whose due time simply passed.
  const recoveryIndicator = issue.interruption?.responsibility === "system" && issue.interruption.state !== "resolved"
    ? <span className="text-xs text-muted-foreground" data-testid="issue-row-interruption">
        {issue.interruption.state === "working" ? "Thinking"
          : issue.interruption.state === "retry_scheduled" ? "Trying again soon" : "Retry available"}
      </span>
    : recoveryAction && !requiresExecutionReconciliation(recoveryAction.cause)
    ? renderRecoveryChip(recoveryAction, selected, { scheduledRetry: issue.scheduledRetry ?? null })
    : null;
  const parkedBlockerIndicator = hasAssignedBacklogBlocker(issue.blockedBy) ? (
    <Badge variant="outline"
      data-testid="issue-row-parked-blocker"
      className="[&>svg]:size-2.5 ml-1.5 gap-0.5 border-amber-500/60 bg-amber-500/15 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
      title="Blocked by parked work — at least one assigned blocker is in backlog and will not wake its assignee."
    >
      <Flag className="h-2.5 w-2.5" aria-hidden />
      Blocked by parked work
    </Badge>
  ) : null;

  if (presentation === "task") {
    const isUnread = unreadState === "visible" || unreadState === "fading";
    const refreshed = appearance === "refreshed";
    const statusLabel = getStatusIconLabel(issue.status, issue.externalConversationState, issue.blockerAttention);
    const statusIcon = <StatusIcon status={issue.status} externalConversationState={issue.externalConversationState} blockerAttention={issue.blockerAttention} size="md" className={selectedStatusClass} />;
    const status = statusSlot ?? (refreshed ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={createIssueDetailPath(issuePathId)}
            state={detailState}
            disableIssueQuicklook
            issuePrefetch={issue}
            onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
            aria-label={`Open task ${identifier} (${statusLabel})`}
            className="task-row-status-link"
            data-slot="task-row-status"
          >
            {statusIcon}
          </Link>
        </TooltipTrigger>
        <TooltipContent className="task-row-status-tooltip">{statusLabel}</TooltipContent>
      </Tooltip>
    ) : statusIcon);
    const taskLink = (
      <Link
        to={createIssueDetailPath(issuePathId)}
        state={detailState}
        disableIssueQuicklook
        issuePrefetch={issue}
        data-inbox-issue-link
        id={checklistRowId}
        aria-current={checklistCurrentStep ? "step" : undefined}
        onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
        onFocus={appearance === "refreshed" ? () => setTitleFocused(true) : undefined}
        onBlur={appearance === "refreshed" ? () => setTitleFocused(false) : undefined}
        onKeyDown={appearance === "refreshed" ? (event) => {
          if (event.key === "Escape") {
            clearHoveredCell();
            setTitleFocused(false);
          }
        } : undefined}
        className={cn(
          "absolute inset-0 rounded-lg no-underline text-inherit focus-visible:z-10 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
          refreshed && "task-row-link",
        )}
      >
        <span className="sr-only">Open {identifier}: {issue.title}</span>
      </Link>
    );
    return (
      <HoveredCellContext.Provider value={hoveredCell}>
        <div
          onMouseEnter={onMouseEnter}
          onMouseMove={refreshed ? handleCellHover : undefined}
          onMouseLeave={refreshed ? () => { clearHoveredCell(); setTitleFocused(false); } : undefined}
          role={refreshed && columnValues ? "row" : undefined}
          data-slot="task-row"
          data-issue-id={issue.id}
          data-issue-row-details={issue.id}
          data-unread={isUnread ? "true" : undefined}
          data-appearance={refreshed ? "refreshed" : undefined}
          data-density={refreshed ? density : undefined}
          data-columns={refreshed && columnValues ? "all" : undefined}
          data-status-hidden={refreshed && columnValues && !visibleColumns.includes("task") ? "true" : undefined}
          data-title-hidden={refreshed && columnValues && !visibleColumns.includes("task") ? "true" : undefined}
          style={refreshed ? { "--task-row-depth": treeGuides } as CSSProperties : undefined}
          data-selected={selected ? "true" : undefined}
          data-current-step={checklistCurrentStep ? "true" : undefined}
          className={cn(
            "group relative flex min-w-0 items-start gap-2 rounded-lg py-2.5 pr-2 text-sm no-underline text-inherit sm:items-center sm:py-2",
            !refreshed && (showUnreadSlot ? "pl-4" : "pl-2 sm:pl-4"),
            "[&_button]:relative [&_button]:z-10",
            selected ? "bg-accent/50 hover:bg-accent/50" : "hover:bg-accent/50",
            checklistCurrentStep && "bg-primary/5",
            refreshed && "task-row-refreshed",
            stableLayout && !refreshed && "task-row-stable",
            className,
          )}
        >
          {taskLink}

          {showUnreadSlot ? (
            <span
              data-testid="issue-row-unread-slot"
              className="absolute left-0 top-3 inline-flex h-4 w-4 items-center justify-center sm:top-1/2 sm:-translate-y-1/2"
            >
              {showUnreadDot ? unreadDotButton : null}
            </span>
          ) : null}

          <span role={refreshed && columnValues ? "cell" : undefined} data-slot="task-row-leading" data-marquee-cell={refreshed ? "task" : undefined} className="flex shrink-0 items-start self-stretch gap-1 pt-px sm:items-center sm:pt-0">
            {treeGuides > 0
              ? Array.from({ length: treeGuides }, (_, level) => {
                const gapForChevron = chevronInGuide && level === treeGuides - 1;
                return (
                  <span
                    key={`task-guide-${level}`}
                    data-slot="task-row-tree-guide"
                    data-chevron-gap={gapForChevron ? "true" : undefined}
                    aria-hidden="true"
                    className="relative block w-4 shrink-0 self-stretch"
                  >
                    <span
                      data-slot="task-row-tree-connector"
                      className="absolute -inset-y-3 left-7 w-px bg-background"
                    >
                      {gapForChevron ? (
                        <span className="absolute inset-0 flex flex-col">
                          <span data-slot="task-row-tree-line" className="flex-1 bg-border" />
                          <span data-slot="task-row-tree-gap" className="h-3.5 shrink-0" />
                          <span data-slot="task-row-tree-line" className="flex-1 bg-border" />
                        </span>
                      ) : (
                        <span data-slot="task-row-tree-line" className="absolute inset-0 bg-border" />
                      )}
                    </span>
                  </span>
                );
              })
              : null}
            {refreshed ? (
              <span data-slot="task-row-leading-control">{leadingControl}</span>
            ) : leadingControl}
            {refreshed && columnValues && !visibleColumns.includes("task") ? null : status}
            {parkedBlockerIndicator}
          </span>

          <span role={refreshed && columnValues ? "cell" : undefined} data-slot="task-row-content" data-marquee-cell={refreshed ? "task" : undefined} className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span data-slot="task-row-title-cluster" className="flex min-w-0 flex-1 items-baseline gap-1.5 sm:items-center">
              {refreshed ? (
                <CellMarquee cell="task" active={titleFocused} slot="task-row-title" contentSlot="task-row-title-text" tabbable={false} className={cn("min-w-0", isUnread && "font-semibold", titleClassName)}>
                  {issue.title}{titleSuffix}
                </CellMarquee>
              ) : <span
                data-slot="task-row-title"
                className={cn(
                  "min-w-0 line-clamp-2 text-sm sm:truncate sm:line-clamp-none",
                  isUnread && "font-semibold",
                  titleClassName,
                )}
              >
                {issue.title}{titleSuffix}
              </span>}
              {stableLayout ? (
                <span data-slot="task-row-recovery">
                  <span className="hidden sm:inline">{recoveryIndicator}</span>
                  {recoveryIndicator ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} aria-label="Task recovery status" className="relative z-10 inline-flex text-muted-foreground sm:hidden">
                          <CircleAlert className="h-4 w-4" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{recoveryIndicator}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </span>
              ) : recoveryIndicator}
              {mobileTitleMeta ? (
                <span className="ml-auto shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground sm:hidden">
                  {mobileTitleMeta}
                </span>
              ) : null}
            </span>
            {checklistDependencyChips ? (
              <span className="flex flex-wrap gap-1">{checklistDependencyChips}</span>
            ) : null}
            {mobileMeta ? (
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            ) : null}
          </span>

          <span
            data-slot="task-row-trailing"
            className="ml-auto hidden min-w-0 shrink-0 items-center gap-2 sm:flex"
          >
            {refreshed && columnValues ? (
              <>
                <TaskRowColumnCells identifier={identifier} values={columnValues} />
                {actions ? <span data-slot="task-row-actions" className="flex shrink-0 items-center gap-1">{actions}</span> : null}
                {onArchive ? <InboxArchiveButton onArchive={onArchive} disabled={archiveDisabled} compact /> : null}
              </>
            ) : (
              <>
                {stableLayout ? (
                  <span data-slot="task-row-external"><ExternalObjectStatusSummary summary={externalObjectSummary} compact /></span>
                ) : externalObjectSummary ? (
                  <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
                ) : null}
                {metadata ? <span data-slot="task-row-metadata" data-marquee-cell={refreshed ? "metadata" : undefined} className="min-w-0">{refreshed ? <CellMarquee cell="metadata">{metadata}</CellMarquee> : metadata}</span> : null}
                {desktopTrailing}
                {actions ? <span data-slot="task-row-actions" className="flex shrink-0 items-center gap-1">{actions}</span> : null}
                {onArchive ? <InboxArchiveButton onArchive={onArchive} disabled={archiveDisabled} compact /> : null}
                {showIdentifier ? (
                  <span data-slot="task-row-identifier" data-marquee-cell={refreshed ? "identifier" : undefined} className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {refreshed ? <CellMarquee cell="identifier">{identifier}</CellMarquee> : identifier}
                  </span>
                ) : null}
                {trailingMeta ? (
                  <span data-slot="task-row-timestamp" data-marquee-cell={refreshed ? "timestamp" : undefined} className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground">
                    {refreshed ? <CellMarquee cell="timestamp">{trailingMeta}</CellMarquee> : trailingMeta}
                  </span>
                ) : null}
              </>
            )}
          </span>
        </div>
      </HoveredCellContext.Provider>
    );
  }

  return (
    <div
      data-issue-row-details={issue.id}
      onMouseEnter={onMouseEnter}
      className={cn(
        // No color transition on the row band: hover/selection must snap
        // instantly. A fade (transition-colors) leaves a trail of fading bands
        // when scrubbing the mouse fast across the list.
        "group relative flex items-start gap-2 rounded-lg py-2.5 pr-3 text-sm no-underline text-inherit sm:items-center sm:py-2 sm:pl-1",
        showUnreadSlot ? "pl-4" : "pl-2",
        "[&_button]:relative [&_button]:z-10",
        // Divider + hover/selected/checklist wash live on the ROOT row band so
        // the tint paints BEHIND the content and `last:border-b-0` matches the
        // real last row. Keeping these on the overlay Link (PR #10526) made the
        // last row keep its border and the hover wash paint over the text.
        showDivider && "border-b border-border last:border-b-0",
        selected ? "hover:bg-transparent" : "hover:bg-accent/50",
        checklistCurrentStep ? "bg-primary/5" : null,
        className,
      )}
    >
      <Link
        to={createIssueDetailPath(issuePathId)}
        state={detailState}
        disableIssueQuicklook
        issuePrefetch={issue}
        data-inbox-issue-link
        id={checklistRowId}
        aria-current={checklistCurrentStep ? "step" : undefined}
        onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
        className={cn(
          // Overlay Link keeps ONLY positioning + focus ring so header controls
          // stay clickable above it; visual washes belong on the root above.
          "absolute inset-0 rounded-lg no-underline text-inherit focus-visible:z-10 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
        )}
      >
        <span className="sr-only">Open {identifier}: {issue.title}</span>
      </Link>
      <span className="flex shrink-0 items-center gap-1 pt-px sm:hidden">
        {mobileLeading ?? <StatusIcon status={issue.status} externalConversationState={issue.externalConversationState} blockerAttention={issue.blockerAttention} size="md" className={selectedStatusClass} />}
        {parkedBlockerIndicator}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span data-slot="task-row-title-cluster" className="flex min-w-0 items-start gap-1.5 sm:order-2 sm:flex-1 sm:items-center">
          <span
            data-slot="task-row-title"
            className={cn("min-w-0 line-clamp-2 text-sm sm:truncate sm:line-clamp-none", titleClassName)}
          >
            {issue.title}{titleSuffix}
          </span>
          {recoveryIndicator}
        </span>
        {checklistDependencyChips ? (
          <span className="flex flex-wrap gap-1 sm:order-3 sm:ml-(--sz-calc-13)">
            {checklistDependencyChips}
          </span>
        ) : null}
        <span className="flex items-center gap-2 self-stretch sm:order-1 sm:shrink-0">
          {showUnreadSlot ? (
            // Reserved leftmost dot gutter (desktop). Present on read and unread
            // rows so the mark-read dot lives to the LEFT of any leading control
            // (a parent's collapse caret, a tree guide) without indenting the row
            // relative to its siblings, and aligns with the non-issue inbox rows
            // that reserve the same w-4 slot.
            <span
              data-testid="issue-row-unread-slot"
              className="hidden h-4 w-4 shrink-0 items-center justify-center self-center sm:inline-flex"
            >
              {showUnreadDot ? unreadDotButton : null}
            </span>
          ) : null}
          {treeGuides > 0
            ? Array.from({ length: treeGuides }, (_, level) => {
              // The innermost guide lands on THIS row's own chevron column; if
              // the row has a chevron, break the line around it so it isn't
              // crossed out.
              const gapForChevron = chevronInGuide && level === treeGuides - 1;
              return (
              // Tree guide: occupies the same flex slot as the parent's
              // chevron column so the line lands under the parent's status
              // column; stretched past the row padding so consecutive rows
              // read as one continuous line.
              <span key={`guide-${level}`} aria-hidden="true" className="relative hidden w-4 shrink-0 self-stretch sm:block">
                {/* The connector drops from under the ancestor's STATUS icon,
                    not its chevron: the status column sits one level (w-4 slot
                    + gap-2 = 2rem) right of this guide slot's left edge.
                    bg-background underlay: dark-mode --border is translucent,
                    so overlapping row segments would stack brighter without
                    an opaque base. */}
                <span className="absolute -inset-y-3 left-8 w-px bg-background">
                  {gapForChevron ? (
                    // Two border segments centering a 14px (h-3.5) transparent
                    // gap for the row's own chevron.
                    <span className="absolute inset-0 flex flex-col">
                      <span className="flex-1 bg-border" />
                      <span className="h-3.5 shrink-0" />
                      <span className="flex-1 bg-border" />
                    </span>
                  ) : (
                    <span className="absolute inset-0 bg-border" />
                  )}
                </span>
              </span>
              );
            })
            : null}
          {desktopLeadingSpacer ? (
            <span className="hidden w-3.5 shrink-0 sm:block" />
          ) : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                <StatusIcon status={issue.status} externalConversationState={issue.externalConversationState} blockerAttention={issue.blockerAttention} size="md" className={selectedStatusClass} />
              </span>
              {checklistStep}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {identifier}
              </span>
              {parkedBlockerIndicator}
            </>
          )}
          {mobileMeta ? (
            <>
              <span className="text-xs text-muted-foreground sm:hidden" aria-hidden="true">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {(onArchive || desktopTrailing || trailingMeta || externalObjectSummary) ? (
        <span className="ml-auto hidden shrink-0 items-center gap-2 sm:order-3 sm:flex sm:gap-3">
          {onArchive ? (
            <InboxArchiveButton onArchive={onArchive} disabled={archiveDisabled} />
          ) : null}
          {externalObjectSummary ? (
            <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
          ) : null}
          {desktopTrailing}
          {trailingMeta ? (
            <span className="text-xs text-muted-foreground">{trailingMeta}</span>
          ) : null}
        </span>
      ) : null}
      {showUnreadDot ? (
        // Inbox rows reserve a mobile gutter on both read and unread rows. The
        // full control stays inside overflow-clipping row containers while its
        // absolute position avoids shifting or covering the leading control.
        <span className="absolute left-0 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center sm:hidden">
          {unreadDotButton}
        </span>
      ) : null}
    </div>
  );
}

function renderRecoveryChip(
  action: IssueRecoveryAction,
  selected: boolean,
  liveness: RecoveryLivenessContext,
): ReactNode {
  const state = deriveActiveRecoveryDisplayState(action, liveness);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const lineage = readRecoveryRetryLineage(action, liveness);
  const label = recoveryChipLabel(state, action.kind, lineage);
  const detail = lineage ? formatRecoveryLineageSummary(lineage) : null;
  return (
    <Badge variant="outline"
      data-testid="issue-row-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      data-recovery-lane={lineage?.lane}
      role="status"
      aria-label={detail ? `${label} — ${detail}` : label}
      className={cn(
        "shrink-0 gap-0.5 text-(length:--text-nano)",
        tone.className,
        selected ? "!border-muted-foreground !text-muted-foreground" : null,
      )}
      title={detail
        ? `${label} — ${detail}. Open the source task to act.`
        : `${label} — open the source task to act.`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </Badge>
  );
}
