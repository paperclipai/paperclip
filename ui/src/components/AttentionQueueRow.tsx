import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  X,
} from "lucide-react";
import type { Agent, AttentionDetailImage, AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  attentionDetailImages,
  attentionDetailLine,
  attentionImageUrl,
  attentionStatus,
  attentionTaskRef,
  decideByLabel,
  isInlineResolvable,
  sourceMeta,
} from "../lib/attention";
import { cn, relativeTime } from "../lib/utils";
import { DecisionTriageStrip } from "./DecisionTriageStrip";
import { StatusGlyph } from "./StatusGlyph";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Textarea } from "./ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";
import { DecisionResolver } from "./DecisionResolver";
import { StalledReviewActions } from "./StalledReviewActions";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Decision-action buttons: a comfortable tap target when the row is narrow
// (h-9 / text-sm), shrinking back to the dense pill (h-6 / text-xs) once the
// row's own container is wide enough (`@xl` ≈ 576px). Container-query driven so
// the row also reflows correctly inside narrow side panels, not just on phones.
const ACTION_BTN = "h-9 gap-1.5 px-3 text-sm @xl:h-6 @xl:gap-1 @xl:px-2 @xl:text-xs";

/** Tomorrow at 9am local time. */
function tomorrowMorningIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** Snooze presets, resolved to a future ISO timestamp at click time. */
const SNOOZE_PRESETS: ReadonlyArray<{ label: string; resolve: () => string }> = [
  { label: "1 hour", resolve: () => new Date(Date.now() + HOUR_MS).toISOString() },
  { label: "4 hours", resolve: () => new Date(Date.now() + 4 * HOUR_MS).toISOString() },
  { label: "Tomorrow morning", resolve: tomorrowMorningIso },
  { label: "Next week", resolve: () => new Date(Date.now() + 7 * DAY_MS).toISOString() },
];

interface AttentionQueueRowProps {
  item: AttentionItem;
  companyId: string;
  expanded: boolean;
  /** Receives the row's item so the parent can pass one stable callback for every row. */
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze?: (item: AttentionItem, snoozedUntil: string) => void;
  /** Restore a snoozed/dismissed row (curtain variant only). */
  onRestore?: (item: AttentionItem) => void;
  /** "active" renders the live queue row; "hidden" renders a curtain row. */
  variant?: "active" | "hidden";
  agentMap?: Map<string, Agent>;
  /** Company agents, for the triage strip's route-to-agent picker. */
  agents?: Agent[];
  /** Render the per-card triage strip (queue/decide-by/snooze/route) when expanded. */
  showTriage?: boolean;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  selected?: boolean;
}

/**
 * Memoized (PAP-13784): the queue renders every feed row in one flat list, so
 * without memo a single keyboard-selection or expand toggle re-renders every
 * row (each carrying a Radix dropdown + mutation). All props are stable or
 * primitive; `item` identity is preserved across refetches by react-query's
 * structural sharing.
 */
export const AttentionQueueRow = memo(function AttentionQueueRow({
  item,
  companyId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onRestore,
  variant = "active",
  agentMap,
  agents,
  showTriage = false,
  currentUserId,
  userLabelMap,
  selected = false,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  // Colour + glyph are borrowed wholesale from the task status system, so a
  // blocking decision reads exactly like a blocked task (DESIGN.md principle 5).
  const status = attentionStatus(item);
  // The task this row belongs to, whichever field the feed put it in.
  const taskRef = attentionTaskRef(item);
  const isHidden = variant === "hidden";
  const inline = !isHidden && isInlineResolvable(item);
  const href = item.subject.href;
  const snoozedUntil = item.dismissal?.kind === "snooze" ? item.dismissal.snoozedUntil : null;
  const detailLine = attentionDetailLine(item) ?? item.whyNow;
  const images = attentionDetailImages(item);
  const hasImages = images.length > 0;
  // The issue (or source) this row points at — used as the target for the
  // "n more" affordance in the expanded gallery.
  const issueHref = item.relatedIssue?.href ?? href;
  // Inline-resolvable active rows expand to reveal their resolver; rows with
  // images expand to reveal a larger gallery (PAP-13544); triage-enabled rows
  // expand to reveal the per-card triage strip (PAP-16032 §4.5). Any of these
  // gives a header/thumbnail click somewhere to go. Non-inline, image-less rows
  // with no triage keep the explicit Open button and never toggle on a stray click.
  const triageEnabled = showTriage && !isHidden;
  const expandable = inline || (!isHidden && hasImages) || triageEnabled;
  const activate = () => {
    if (expandable) onToggleExpand(item);
  };
  const onHeaderKeyDown = (e: KeyboardEvent) => {
    if (!expandable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleExpand(item);
    }
  };

  // Which rows contribute an action bar. Inline rows carry compact decision
  // verbs; deep-link rows carry an Open button; curtain rows carry Restore.
  const compactActions = !isHidden ? collectCompactActions(item) : [];
  const showOpen = !inline && !!href;
  const showRestore = isHidden && !!onRestore;
  // An expanded inline row hands its footer to the resolver, which owns the
  // decision verbs — so the toggle rides alongside them on one row rather than
  // stranding a lone "See less" under the buttons. That makes the collapsed
  // footer a swap rather than a survivor, so it crossfades with the panel.
  const hasCollapsedOnlyContent = hasImages || inline;

  // Disclosure control. Now the row's only expand affordance: it names what it
  // does instead of leaving a bare chevron to be decoded, and it sits at the
  // bottom-left where the eye lands after reading the row.
  const toggle = expandable ? (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
      aria-label={expanded ? "Collapse decision" : "Expand decision"}
      aria-expanded={expanded}
      onClick={activate}
    >
      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      {expanded ? "See less" : "See more"}
    </button>
  ) : null;

  /**
   * The row's action bar: disclosure on the left, decision verbs on the right.
   * Rendered either inside the collapsed-only cluster (inline rows, where the
   * resolver takes it over once expanded) or as a standing sibling (everything
   * else). `compact` is false for the standing copy so an expanded row does not
   * show collapsed verbs beside the panel's own.
   */
  const renderFooter = ({ compact }: { compact: boolean }) => {
    const showCompact = compactActions.length > 0 && (compact || !expanded);
    if (!toggle && !showCompact && !showOpen && !showRestore) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2" data-attention-actions="true">
        {toggle ?? <span />}

        <div className="flex flex-wrap items-center gap-2 @xl:justify-end">
          {showCompact && (
            <CompactDecisionActions item={item} companyId={companyId} onOpen={() => onToggleExpand(item)} />
          )}

          {showOpen && (
            <Button asChild variant="default" size="xs" className={ACTION_BTN}>
              <Link to={href!}>
                Open
                <ExternalLink className="h-3 w-3" />
              </Link>
            </Button>
          )}

          {showRestore && (
            <Button type="button" variant="outline" size="xs" className={ACTION_BTN} onClick={() => onRestore(item)}>
              <RotateCcw className="h-3 w-3" />
              Restore
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        "@container relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-4",
        // The feed is uncapped, so off-screen rows must not cost layout/paint
        // while scrolling. The intrinsic-size estimate only matters before a
        // row's first paint; `auto` keeps the real measured height afterwards.
        "[content-visibility:auto] [contain-intrinsic-size:auto_104px]",
        "motion-safe:transition-[opacity,transform,border-color,background-color] motion-safe:duration-200 motion-safe:ease-out hover:border-border/80",
        isHidden && "bg-muted/30 opacity-80 hover:opacity-100",
        selected && "border-ring ring-1 ring-ring",
      )}
      id={`attention-row-${item.id}`}
      data-attention-row
      data-attention-row-id={item.id}
      data-attention-source={item.sourceKind}
      data-attention-severity={item.severity}
    >
      {/* Meta band: one breadcrumb of identity on the left (kind → task →
          project), recency + overflow on the right. Not part of the clickable
          headline, so the menu never toggles it. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <StatusGlyph status={status} size="md" />
            {meta.label}
          </span>
          {taskRef && (
            <>
              <EyebrowSeparator />
              <Link
                to={taskRef.href ?? "#"}
                className="font-mono text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                {taskRef.identifier}
              </Link>
            </>
          )}
          {item.decideBy && (
            <>
              <EyebrowSeparator />
              <span
                className="inline-flex items-center gap-1 text-(length:--text-nano) text-muted-foreground"
                data-attention-decide-by={item.decideBy}
                title={decideByProvenance(item) ? `Set by ${decideByProvenance(item)}` : undefined}
              >
                <CalendarClock className="h-3 w-3" />
                {decideByLabel(item.decideBy)}
                {decideByProvenance(item) && (
                  <span className="text-muted-foreground/80">· set by {decideByProvenance(item)}</span>
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1" data-attention-menu="true">
          {isHidden && snoozedUntil ? (
            <span
              className="text-(length:--text-nano) text-muted-foreground"
              title={`Reappears ${new Date(snoozedUntil).toLocaleString()}`}
            >
              Reappears {reappearLabel(snoozedUntil)}
            </span>
          ) : (
            <span className="text-(length:--text-nano) text-muted-foreground">{relativeTime(item.activityAt)}</span>
          )}
          {!isHidden && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label="Row actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onSnooze && <SnoozeSubmenu onSnooze={(iso) => onSnooze(item, iso)} />}
                <DropdownMenuItem onClick={() => onDismiss(item)}>
                  <X className="h-4 w-4" />
                  Dismiss
                </DropdownMenuItem>
                {href && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to={href}>Open source</Link>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Headline — the primary expand target for inline rows. Title wraps to
          two lines instead of truncating to a sliver on narrow screens. */}
      <div
        className={cn(
          "min-w-0 rounded-md",
          expandable && "cursor-pointer focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none",
        )}
        {...(expandable
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": expanded,
              "aria-label": expanded ? "Collapse decision" : "Expand decision",
              onClick: activate,
              onKeyDown: onHeaderKeyDown,
            }
          : {})}
      >
        <span className="line-clamp-2 text-sm font-medium text-foreground" title={item.subject.title ?? undefined}>
          {item.subject.title ?? meta.label}
        </span>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</p>
      </div>

      {/* Collapsed-only content. It has no counterpart to morph into — the
          thumbnail strip becomes a full gallery, and an inline row's footer is
          replaced by the resolver's own — so it rides an inverse disclosure and
          crossfades against the panel below: this shrinks and fades out on the
          same tokens as that grows and fades in, instead of popping. */}
      {hasCollapsedOnlyContent && (
        <Collapsible open={!expanded} className="contents">
          <CollapsibleContent data-decision-disclosure className="-mt-4">
            <div className="flex flex-col gap-4 pt-4">
              {hasImages && <ThumbnailStack images={images} />}
              {inline && renderFooter({ compact: true })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* The disclosure panel. Collapsible measures the panel and publishes its
          height, so the card grows and shrinks to a real number rather than
          snapping open. `contents` keeps the Root out of the layout, so a
          collapsed row does not pay a flex gap for an empty wrapper — and once
          the exit finishes Radix unmounts the panel, so a collapsed row is not
          left with a live resolver behind it. */}
      <Collapsible open={expanded} onOpenChange={() => onToggleExpand(item)} className="contents">
        <CollapsibleContent data-decision-disclosure className="-mt-4">
          <div className="flex flex-col gap-4 pt-4">
            {hasImages && <ExpandedImages images={images} issueHref={issueHref} />}
            {triageEnabled && <DecisionTriageStrip item={item} companyId={companyId} agents={agents} />}
            {inline && (
              <InlineResolver
                item={item}
                companyId={companyId}
                agentMap={agentMap}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                toggle={toggle}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* A non-inline row keeps one footer across both states — its Open or
          Restore button and its toggle are the same control either way, so it
          stays put rather than crossfading with itself. */}
      {!inline && renderFooter({ compact: false })}
    </div>
  );
});

/**
 * "·" between eyebrow segments.
 *
 * The eyebrow is a flat list of two facts (decision kind, task key), not a
 * hierarchy, so a middle dot reads more honestly than the "/" this started as —
 * a slash implies containment that the two segments do not have.
 */
function EyebrowSeparator() {
  return (
    <span className="text-xs text-muted-foreground" aria-hidden>
      ·
    </span>
  );
}

type CompactDecisionAction = "accept" | "approve" | "reject" | "request_revision";

function compactDecisionAction(item: AttentionItem, verbId: string): CompactDecisionAction | null {
  if (item.sourceKind === "approval" && (verbId === "approve" || verbId === "reject" || verbId === "request_revision")) {
    return verbId;
  }
  if (item.sourceKind === "join_request" && (verbId === "approve" || verbId === "reject")) {
    return verbId;
  }
  if (
    item.sourceKind === "issue_thread_interaction"
    && item.subject.metadata?.kind === "request_confirmation"
    && (verbId === "accept" || verbId === "reject")
  ) {
    return verbId;
  }
  return null;
}

/**
 * Weight used to order a decision's verbs. The affirmative verb always lands
 * rightmost — the same place in every row, collapsed or expanded — so the
 * operator's aim never has to move with the verb list.
 */
const VERB_ORDER: Record<"outline" | "destructive" | "default", number> = {
  outline: 0,
  destructive: 1,
  default: 2,
};

interface CompactAction {
  action: CompactDecisionAction;
  label: string;
  id: string;
  description: string;
}

/** The compact accept/reject verbs a collapsed row can resolve in place. */
function collectCompactActions(item: AttentionItem): CompactAction[] {
  return item.decisionVerbs
    .slice(0, 3)
    .flatMap((verb) => {
      const action = compactDecisionAction(item, verb.id);
      return action ? [{ action, label: verb.label, id: verb.id, description: verb.description ?? "" }] : [];
    })
    .sort((a, b) => VERB_ORDER[decisionVerbVariant(a)] - VERB_ORDER[decisionVerbVariant(b)]);
}

function CompactDecisionActions({
  item,
  companyId,
  onOpen,
}: {
  item: AttentionItem;
  companyId: string;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const actions = collectCompactActions(item);

  const decision = useMutation<unknown, Error, CompactDecisionAction>({
    mutationFn: (action: CompactDecisionAction) => {
      if (item.sourceKind === "approval") {
        if (action === "approve") return approvalsApi.approve(item.subject.id);
        if (action === "reject") return approvalsApi.reject(item.subject.id);
        return approvalsApi.requestRevision(item.subject.id);
      }
      if (item.sourceKind === "join_request") {
        return action === "approve"
          ? accessApi.approveJoinRequest(companyId, item.subject.id)
          : accessApi.rejectJoinRequest(companyId, item.subject.id);
      }
      if (item.sourceKind === "issue_thread_interaction") {
        const issueId = item.subject.metadata?.issueId;
        if (typeof issueId !== "string") throw new Error("Missing issue reference for this decision.");
        if (action === "accept") return issuesApi.acceptInteraction(issueId, item.subject.id);
        return issuesApi.rejectInteraction(issueId, item.subject.id);
      }
      throw new Error("This decision must be completed from its detail view.");
    },
    onSuccess: (_result, action) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      if (item.sourceKind === "approval") {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
      }
      pushToast({
        title: compactDecisionSuccessLabel(item.sourceKind, action),
        tone: "success",
      });
    },
    onError: (error, action) => {
      pushToast({
        title: `Could not ${decisionLabel(action)}`,
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (actions.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-2 @xl:w-auto @xl:justify-end @xl:gap-1" aria-label="Decision actions">
      {actions.map(({ action, id, label, description }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description })}
          size="xs"
          className={cn(ACTION_BTN, "min-w-0 flex-1 @xl:flex-none")}
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            if (item.sourceKind === "issue_thread_interaction" && action === "reject") {
              onOpen();
              return;
            }
            decision.mutate(action);
          }}
        >
          {decision.isPending && decision.variables === action && <Loader2 className="h-3 w-3 animate-spin" />}
          {label}
        </Button>
      ))}
    </div>
  );
}

function decisionLabel(action: CompactDecisionAction): string {
  if (action === "request_revision") return "sent for revision";
  if (action === "accept" || action === "approve") return "approved";
  return "rejected";
}

function compactDecisionSuccessLabel(sourceKind: AttentionItem["sourceKind"], action: CompactDecisionAction): string {
  if (sourceKind === "approval") return `Approval ${decisionLabel(action)}`;
  if (sourceKind === "join_request") return `Join request ${decisionLabel(action)}`;
  return action === "accept" ? "Confirmation accepted" : "Confirmation declined";
}

function decisionVerbVariant(verb: AttentionItem["decisionVerbs"][number]): "default" | "outline" | "destructive" {
  const text = `${verb.label} ${verb.description ?? ""}`.toLowerCase();
  if (/\b(reject|decline|deny|delete|remove)\b/.test(text)) return "destructive";
  if (/\b(accept|approve|confirm|apply)\b/.test(text)) return "default";
  return "outline";
}

/** Square screenshot thumbnails at the right of the description (plan §10). */
function ThumbnailStack({ images }: { images: AttentionDetailImage[] }) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex shrink-0 items-center">
      <div className="flex -space-x-3">
        {visible.map((img, index) => (
          <img
            key={`${img.assetId}-${index}`}
            src={attentionImageUrl(img.assetId)}
            alt={img.alt ?? ""}
            loading="lazy"
            style={{ zIndex: visible.length - index }}
            className="h-11 w-11 rounded-md border border-border bg-muted object-cover shadow-sm"
          />
        ))}
      </div>
      {extra > 0 && (
        <span className="ml-1 inline-flex h-6 items-center rounded-md border border-border bg-muted px-1.5 text-(length:--text-nano) font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  );
}

/**
 * Larger image gallery shown when a row is expanded (PAP-13544). Shows the
 * first three screenshots at a readable size; if more exist, an "n more" tile
 * links through to the issue where the full set lives.
 */
function ExpandedImages({ images, issueHref }: { images: AttentionDetailImage[]; issueHref: string | null }) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex flex-wrap items-stretch gap-2" data-attention-expanded-images="true">
      {visible.map((img, index) => {
        const src = attentionImageUrl(img.assetId);
        const key = `${img.assetId}-${index}`;
        const image = (
          <img
            src={src}
            alt={img.alt ?? ""}
            loading="lazy"
            className="h-32 w-44 rounded-md border border-border bg-muted object-cover shadow-sm"
          />
        );
        return issueHref ? (
          <Link
            key={key}
            to={issueHref}
            // No task quicklook on evidence. `Link` upgrades any /issues/ href
            // into a hover preview, which here pops a text card over the very
            // screenshot being examined — and because expanding a row mounts
            // this gallery directly under a stationary pointer, the preview
            // opens unbidden and can outlive the pointer that never entered it.
            disableIssueQuicklook
            className="block rounded-md focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            {image}
          </Link>
        ) : (
          <span key={key} className="block">
            {image}
          </span>
        );
      })}
      {extra > 0 && (issueHref ? (
        <Link
          to={issueHref}
          // Same gallery, same pointer trap — see the thumbnail note above.
          disableIssueQuicklook
          onClick={(e) => e.stopPropagation()}
          className="flex h-32 w-24 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
        >
          <span className="text-base font-semibold">{extra} more</span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-(length:--text-nano)">
            View issue
            <ExternalLink className="h-3 w-3" />
          </span>
        </Link>
      ) : (
        <span className="flex h-32 w-24 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-sm font-semibold text-muted-foreground">
          {extra} more
        </span>
      ))}
    </div>
  );
}

/** Snooze submenu: presets + a custom date-time (plan §6). */
function SnoozeSubmenu({ onSnooze }: { onSnooze: (snoozedUntil: string) => void }) {
  const [customValue, setCustomValue] = useState("");
  const applyCustom = () => {
    if (!customValue) return;
    const ts = new Date(customValue);
    if (Number.isNaN(ts.getTime())) return;
    onSnooze(ts.toISOString());
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <AlarmClock className="h-4 w-4" />
        Snooze
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {SNOOZE_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.label} onClick={() => onSnooze(preset.resolve())}>
            {preset.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Custom picker: a non-menu-item region so interacting with the input
            doesn't close the menu (guard keydown/select against Radix typeahead). */}
        <div
          className="flex flex-col gap-1.5 px-2 py-1.5"
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            Custom
          </span>
          <input
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
          />
          <Button type="button" size="xs" disabled={!customValue} onClick={applyCustom}>
            Snooze until…
          </Button>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Who set this row's decide-by deadline, for the card's provenance line
 * ("· set by Prioritizer"). Returns null when unattributed so the chip shows
 * the deadline alone rather than a hollow "set by".
 */
function decideByProvenance(item: AttentionItem): string | null {
  const attribution = item.decideByAttribution;
  if (!attribution) return null;
  if (attribution.type === "agent") return attribution.agentName ?? "an agent";
  return "you";
}

/** Compact "when does this snooze end" label, e.g. `in 2h`, `in 3d`. */
function reappearLabel(snoozedUntil: string): string {
  const diffMs = new Date(snoozedUntil).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "soon";
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `in ${diffDay}d`;
}

/**
 * Expanded-row content. Resolvers that own their decision verbs also render the
 * row's footer, so the disclosure toggle (`toggle`) sits on the same line as the
 * buttons. The issue-thread interaction card keeps its verbs internally — it is
 * shared with the issue thread surface — so there the toggle gets its own row.
 */
function InlineResolver({
  item,
  companyId,
  agentMap,
  currentUserId,
  userLabelMap,
  toggle,
}: {
  item: AttentionItem;
  companyId: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  toggle: ReactNode;
}) {
  if (item.sourceKind === "decision") {
    return (
      <DecisionResolver
        companyId={companyId}
        decisionId={item.subject.id}
        originIssue={item.relatedIssue}
        agentMap={agentMap}
      />
    );
  }

  if (item.sourceKind === "issue_thread_interaction") {
    const issueId = (item.subject.metadata?.issueId as string | undefined) ?? item.relatedIssue?.id;
    if (!issueId) {
      return <p className="text-xs text-muted-foreground">Missing issue reference for this decision.</p>;
    }
    return (
      <>
        <AttentionInteractionResolver
          companyId={companyId}
          issueId={issueId}
          interactionId={item.subject.id}
          agentMap={agentMap}
          currentUserId={currentUserId}
          userLabelMap={userLabelMap}
        />
        {toggle && <div className="flex items-center">{toggle}</div>}
      </>
    );
  }

  if (item.sourceKind === "approval") {
    return <ApprovalResolver item={item} companyId={companyId} toggle={toggle} />;
  }

  if (item.sourceKind === "join_request") {
    return <JoinRequestResolver item={item} companyId={companyId} toggle={toggle} />;
  }

  if (item.sourceKind === "review") {
    // Inline only for stalled reviews (server sets inlineResolvable then); the
    // subject IS the issue, so its id is the decision target.
    return (
      <StalledReviewActions
        issueId={item.subject.id}
        companyId={companyId}
        footerSlot={toggle}
      />
    );
  }

  return null;
}

/** Footer shared by the resolvers that own their verbs: toggle left, verbs right. */
function ResolverFooter({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-attention-actions="true">
      {toggle ?? <span />}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ApprovalResolver({ item, companyId, toggle }: { item: AttentionItem; companyId: string; toggle: ReactNode }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
  };
  const approve = useMutation({
    mutationFn: () => approvalsApi.approve(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => approvalsApi.reject(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const revise = useMutation({
    mutationFn: () => approvalsApi.requestRevision(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const pending = approve.isPending || reject.isPending || revise.isPending;

  // Verb order matches the collapsed row exactly (revise → reject → approve),
  // so expanding never moves the button the operator was already aiming at.
  return (
    <>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional decision note…"
        className="min-h-16 text-sm"
      />
      <ResolverFooter toggle={toggle}>
        <Button size="sm" variant="outline" onClick={() => revise.mutate()} disabled={pending}>
          {revise.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Request revision
        </Button>
        <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
          {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Reject
        </Button>
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Approve
        </Button>
      </ResolverFooter>
    </>
  );
}

function JoinRequestResolver({ item, companyId, toggle }: { item: AttentionItem; companyId: string; toggle: ReactNode }) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
  };
  const approve = useMutation({
    mutationFn: () => accessApi.approveJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => accessApi.rejectJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
  });
  const pending = approve.isPending || reject.isPending;

  return (
    <ResolverFooter toggle={toggle}>
      <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
        {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Reject
      </Button>
      <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
        {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Approve
      </Button>
    </ResolverFooter>
  );
}
