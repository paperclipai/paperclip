import type { ReactNode } from "react";
import type { ExternalObjectSummary, Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Archive, Eye, Flag } from "lucide-react";
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
import { StatusIcon } from "./StatusIcon";
import { productivityReviewTriggerLabel } from "./ProductivityReviewBadge";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";
import { Badge } from "@/components/ui/badge";

export type IssueRowUnreadState = "hidden" | "visible" | "fading";
export type IssueRowPresentation = "legacy" | "task";

export interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  selected?: boolean;
  /** Opt-in canonical collection layout. Legacy remains the default until each surface migrates. */
  presentation?: IssueRowPresentation;
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
  leadingControl,
  statusSlot,
  metadata,
  actions,
  showIdentifier = true,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
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
  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  // A row participates in the unread system whenever `unreadState` is supplied.
  // Canonical rows overlay this affordance in their shared gutter, while legacy
  // inbox rows retain their reserved slot until that presentation is migrated.
  const showUnreadSlot = unreadState != null;
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
  const productivityReview = issue.productivityReview ?? null;
  const productivityReviewIndicator = productivityReview ? (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
        selected ? "border-muted-foreground text-muted-foreground" : null,
      )}
      title={`Productivity review: ${productivityReviewTriggerLabel(productivityReview.trigger)}`}
      aria-label="Productivity review open"
    >
      <Eye className="h-2.5 w-2.5" aria-hidden />
    </span>
  ) : null;
  const hasChecklistStep = checklistStepNumber !== null;
  const checklistStep = hasChecklistStep ? (
    <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
      {checklistStepNumber}.
    </span>
  ) : null;
  const recoveryAction = issue.activeRecoveryAction ?? null;
  // The row already carries the issue's own scheduled retry, so the chip can tell a retry the
  // scheduler is actually running from one whose due time simply passed.
  const recoveryIndicator = recoveryAction
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
    return (
      <div
        onMouseEnter={onMouseEnter}
        data-slot="task-row"
        data-unread={isUnread ? "true" : undefined}
        className={cn(
          "group relative flex min-w-0 items-start gap-2 rounded-lg py-2.5 pl-4 pr-2 text-sm no-underline text-inherit sm:items-center sm:py-2",
          "[&_button]:relative [&_button]:z-10",
          selected ? "bg-accent/50 hover:bg-accent/50" : "hover:bg-accent/50",
          checklistCurrentStep && "bg-primary/5",
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
          className="absolute inset-0 rounded-lg no-underline text-inherit focus-visible:z-10 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
        >
          <span className="sr-only">Open {identifier}: {issue.title}</span>
        </Link>

        {showUnreadSlot ? (
          <span
            data-testid="issue-row-unread-slot"
            className="absolute left-0 top-3 inline-flex h-4 w-4 items-center justify-center sm:top-1/2 sm:-translate-y-1/2"
          >
            {showUnreadDot ? unreadDotButton : null}
          </span>
        ) : null}

        <span data-slot="task-row-leading" className="flex shrink-0 items-center gap-1 pt-px sm:pt-0">
          {treeGuides > 0
            ? Array.from({ length: treeGuides }, (_, level) => {
              const gapForChevron = chevronInGuide && level === treeGuides - 1;
              return (
                <span
                  key={`task-guide-${level}`}
                  data-slot="task-row-tree-guide"
                  aria-hidden="true"
                  className="relative hidden w-4 shrink-0 self-stretch sm:block"
                >
                  <span
                    data-slot="task-row-tree-connector"
                    className="absolute -inset-y-3 left-7 w-px bg-background"
                  >
                    {gapForChevron ? (
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
          {leadingControl}
          {statusSlot ?? (
            <StatusIcon
              status={issue.status}
              blockerAttention={issue.blockerAttention}
              size="md"
              className={selectedStatusClass}
            />
          )}
          {productivityReviewIndicator}
          {parkedBlockerIndicator}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span data-slot="task-row-title-cluster" className="flex min-w-0 flex-1 items-start gap-1.5 sm:items-center">
            <span
              data-slot="task-row-title"
              className={cn(
                "min-w-0 line-clamp-2 text-sm sm:truncate sm:line-clamp-none",
                isUnread && "font-semibold",
                titleClassName,
              )}
            >
              {issue.title}{titleSuffix}
            </span>
            {recoveryIndicator}
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
          {externalObjectSummary ? (
            <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
          ) : null}
          {metadata ? <span data-slot="task-row-metadata" className="min-w-0">{metadata}</span> : null}
          {desktopTrailing}
          {actions ? <span data-slot="task-row-actions" className="flex shrink-0 items-center gap-1">{actions}</span> : null}
          {onArchive ? <InboxArchiveButton onArchive={onArchive} disabled={archiveDisabled} compact /> : null}
          {showIdentifier ? (
            <span data-slot="task-row-identifier" className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
              {identifier}
            </span>
          ) : null}
          {trailingMeta ? (
            <span data-slot="task-row-timestamp" className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground">
              {trailingMeta}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div
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
        {mobileLeading ?? <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="md" className={selectedStatusClass} />}
        {productivityReviewIndicator}
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
                <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="md" className={selectedStatusClass} />
                {productivityReviewIndicator}
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
