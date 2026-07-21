import { memo, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GraduationCap,
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
  attentionToneStyle,
  isInlineResolvable,
  severityBadge,
  sourceMeta,
} from "../lib/attention";
import { isTrainable } from "../lib/decisionTraining";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";
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
import { ProjectTile } from "./ProjectTile";

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
  /** Open the decision-training drawer for this row (create or view). */
  onTrain?: (item: AttentionItem) => void;
  /** Restore a snoozed/dismissed row (curtain variant only). */
  onRestore?: (item: AttentionItem) => void;
  /** "active" renders the live queue row; "hidden" renders a curtain row. */
  variant?: "active" | "hidden";
  agentMap?: Map<string, Agent>;
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
  onTrain,
  onRestore,
  variant = "active",
  agentMap,
  currentUserId,
  userLabelMap,
  selected = false,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  const tone = attentionToneStyle(item);
  const sevBadge = severityBadge(item.severity);
  const Icon = meta.icon;
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
  // images expand to reveal a larger gallery (PAP-13544). Either case gives a
  // header/thumbnail click somewhere to go. Non-inline, image-less rows keep the
  // explicit Open button and never toggle on a stray click.
  const expandable = inline || (!isHidden && hasImages);
  // Any issue-anchored approval or interaction is
  // trainable at any time (pending or resolved). Trained/untrained renders
  // purely from the feed's `trainingExampleId` — no per-row fetch.
  const trainable = !isHidden && !!onTrain && isTrainable(item);
  const trained = item.trainingExampleId != null;

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
  const showCompact = !expanded && compactActions.length > 0;
  const showOpen = !inline && !!href;
  const showRestore = isHidden && !!onRestore;
  const showActionBar = showCompact || showOpen || showRestore;
  // Left gutter width (chevron + gap) so the stacked content aligns under the
  // headline in the wide layout; when narrow, everything runs full-bleed.
  const gutterIndent = "@xl:pl-6";

  return (
    <div
      className={cn(
        "@container relative flex flex-col overflow-hidden border border-border bg-card",
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
      {/* Type accent bar (canonical color map — never severity). */}
      <span className={cn("absolute inset-y-0 left-0 w-1", tone.accent)} aria-hidden />

      <div className="flex items-start gap-2 py-3 pl-4 pr-3">
        {/* Expand affordance / spacer gutter — keeps headlines aligned across the list. */}
        {expandable ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
            aria-label={expanded ? "Collapse decision" : "Expand decision"}
            aria-expanded={expanded}
            onClick={activate}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="mt-0.5 hidden h-4 w-4 shrink-0 @xl:block" aria-hidden />
        )}

        {/* Content column: a single vertical stack that fills the full width on
            mobile (no competing right-hand controls) and reads top-to-bottom. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Meta band: identity on the left, recency + overflow on the right.
              Not part of the clickable headline, so the menu never toggles it. */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Icon className={cn("h-3.5 w-3.5", tone.icon)} />
                {meta.label}
              </span>
              {sevBadge && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-sm border px-1.5 py-px text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)",
                    sevBadge.className,
                  )}
                >
                  {sevBadge.label}
                </span>
              )}
              {item.relatedIssue?.identifier && (
                <Link
                  to={item.relatedIssue.href ?? "#"}
                  className="font-mono text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  {item.relatedIssue.identifier}
                </Link>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1" data-attention-menu="true">
              {trainable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn(trained ? "text-primary" : "text-muted-foreground")}
                  aria-label={trained ? "View training example" : "Train this decision"}
                  aria-pressed={trained}
                  title={trained ? "Trained — view example" : "Train this decision"}
                  data-training-state={trained ? "trained" : "untrained"}
                  data-testid="attention-train-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTrain?.(item);
                  }}
                >
                  <GraduationCap className={cn("h-4 w-4", trained && "fill-primary/25")} />
                </Button>
              )}
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

          {/* Headline — the primary expand target for inline rows. Title now wraps
              to two lines instead of truncating to a sliver on narrow screens. */}
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

          {/* Context row: project identity and evidence thumbnails move below the
              text so they never squeeze the headline on mobile. */}
          {(item.project || (hasImages && !expanded) || (trainable && trained)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {item.project && <ProjectMeta project={item.project} />}
              {trainable && trained && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-px text-(length:--text-nano) font-medium text-primary hover:bg-primary/15"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTrain?.(item);
                  }}
                  data-testid="attention-trained-badge"
                >
                  <GraduationCap className="h-3 w-3 fill-primary/25" />
                  Trained ✓
                </button>
              )}
              {hasImages && !expanded && <ThumbnailStack images={images} />}
            </div>
          )}

          {/* Action bar: full-width, thumb-reachable buttons on mobile;
              right-aligned dense pills on desktop. Sibling of the headline so
              taps never toggle expand. */}
          {showActionBar && (
            <div
              className={cn("flex flex-wrap items-center gap-2 @xl:justify-end", gutterIndent)}
              data-attention-actions="true"
            >
              {showCompact && (
                <CompactDecisionActions
                  item={item}
                  companyId={companyId}
                  onOpen={() => onToggleExpand(item)}
                />
              )}

              {showOpen && (
                <Button asChild variant="outline" size="xs" className={cn(ACTION_BTN, "w-full @xl:w-auto")}>
                  <Link to={href!}>
                    Open
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </Button>
              )}

              {showRestore && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className={cn(ACTION_BTN, "w-full @xl:w-auto")}
                  onClick={() => onRestore(item)}
                >
                  <RotateCcw className="h-3 w-3" />
                  Restore
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {expanded && (hasImages || inline) && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200">
          {hasImages && <ExpandedImages images={images} issueHref={issueHref} />}
          {inline && (
            <InlineResolver
              item={item}
              companyId={companyId}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
            />
          )}
        </div>
      )}
    </div>
  );
});

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

/** The compact accept/reject verbs a collapsed row can resolve in place. */
function collectCompactActions(item: AttentionItem): Array<{ action: CompactDecisionAction; label: string; id: string }> {
  return item.decisionVerbs.slice(0, 3).flatMap((verb) => {
    const action = compactDecisionAction(item, verb.id);
    return action ? [{ action, label: verb.label, id: verb.id }] : [];
  });
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
      {actions.map(({ action, id, label }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description: "" })}
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

/** Inline project identity keeps useful context without a competing badge. */
function ProjectMeta({ project }: { project: NonNullable<AttentionItem["project"]> }) {
  return (
    <span
      className="inline-flex max-w-(--sz-12rem) items-center gap-1.5 text-(length:--text-nano) text-muted-foreground"
      title={project.name}
      data-testid="attention-project-meta"
    >
      <ProjectTile color={project.color} icon={project.icon} size="xs" />
      <span className="truncate">{project.name}</span>
    </span>
  );
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

function InlineResolver({
  item,
  companyId,
  agentMap,
  currentUserId,
  userLabelMap,
}: {
  item: AttentionItem;
  companyId: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  if (item.sourceKind === "issue_thread_interaction") {
    const issueId = (item.subject.metadata?.issueId as string | undefined) ?? item.relatedIssue?.id;
    if (!issueId) {
      return <p className="text-xs text-muted-foreground">Missing issue reference for this decision.</p>;
    }
    return (
      <AttentionInteractionResolver
        companyId={companyId}
        issueId={issueId}
        interactionId={item.subject.id}
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
      />
    );
  }

  if (item.sourceKind === "approval") {
    return <ApprovalResolver item={item} companyId={companyId} />;
  }

  if (item.sourceKind === "join_request") {
    return <JoinRequestResolver item={item} companyId={companyId} />;
  }

  return null;
}

function ApprovalResolver({ item, companyId }: { item: AttentionItem; companyId: string }) {
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

  return (
    <div className="space-y-3">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional decision note…"
        className="min-h-16 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => revise.mutate()} disabled={pending}>
          {revise.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Request revision
        </Button>
        <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
          {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Reject
        </Button>
      </div>
    </div>
  );
}

function JoinRequestResolver({ item, companyId }: { item: AttentionItem; companyId: string }) {
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
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
        {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Approve
      </Button>
      <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
        {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Reject
      </Button>
    </div>
  );
}
