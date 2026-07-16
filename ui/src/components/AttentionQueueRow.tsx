import { memo, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  X,
} from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  attentionDetailLine,
  isInlineResolvable,
  severityBadge,
  sourceMeta,
} from "../lib/attention";
import { getProjectIcon } from "../lib/project-icons";
import { cn, projectUrl, relativeTime } from "../lib/utils";
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
  currentUserId,
  userLabelMap,
  selected = false,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  const sevBadge = severityBadge(item.severity);
  const Icon = meta.icon;
  const isHidden = variant === "hidden";
  const inline = !isHidden && isInlineResolvable(item);
  const href = item.subject.href;
  const snoozedUntil = item.dismissal?.kind === "snooze" ? item.dismissal.snoozedUntil : null;
  const detailLine = attentionDetailLine(item) ?? item.whyNow;
  // Only inline-resolvable active rows can expand; that's the only case where a
  // whole-header click has somewhere to go (plan §5). Non-inline rows keep the
  // explicit Open button and never toggle on a stray click.
  const expandable = inline;

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

  // Footer CTAs (3a): every card carries one solid advance verb and at most one
  // outline counter-verb from the six-verb vocabulary. One-tap decision cards
  // get Approve/Reject; other inline cards get Answer/Review (expand); deep-link
  // cards get Review/Open; curtain rows get Restore. Mutually exclusive so no
  // card ever shows more than one advance verb.
  const decisionCtas = !isHidden ? collectDecisionCtas(item) : null;
  const showDecision = !expanded && decisionCtas !== null;
  const showExpandVerb = !expanded && !decisionCtas && inline;
  const showOpen = !isHidden && !decisionCtas && !inline && !!href;
  const showRestore = isHidden && !!onRestore;
  const showCtas = showDecision || showExpandVerb || showOpen || showRestore;
  // Context pathway (4a): every card with a source href carries a footer-left
  // "View …" link — active, expanded, and curtain rows alike — so context is
  // never buried in the overflow menu.
  const showActionBar = showCtas || !!href;

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
                <Icon className="h-3.5 w-3.5" />
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
                  className="inline-flex min-w-0 items-baseline gap-1.5 text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="font-mono">{item.relatedIssue.identifier}</span>
                  {item.relatedIssue.title && (
                    <span className="max-w-(--sz-16rem) truncate">{item.relatedIssue.title}</span>
                  )}
                </Link>
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
                  {/* Deferral verbs only (4a): the context pathway moved to the
                      always-visible footer-left link, so the menu no longer
                      hides navigation. */}
                  <DropdownMenuContent align="end">
                    {onSnooze && <SnoozeSubmenu onSnooze={(iso) => onSnooze(item, iso)} />}
                    <DropdownMenuItem onClick={() => onDismiss(item)}>
                      <X className="h-4 w-4" />
                      Dismiss
                    </DropdownMenuItem>
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

          {/* Context row: project identity only (5b). Evidence thumbnails were
              dropped from the card — screenshots live one click away behind the
              footer-left context link, keeping the card two text lines tall. */}
          {item.project && <ProjectMeta project={item.project} />}

          {/* Persistent footer bar: context link left (4a), CTAs right at one
              size (3a). Sibling of the headline so taps never toggle expand. */}
          {showActionBar && (
            <div
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
              data-attention-actions="true"
            >
              {href ? (
                <Link
                  to={href}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  data-attention-context-link="true"
                  onClick={(e) => e.stopPropagation()}
                >
                  {meta.contextLabel}
                  <span aria-hidden>→</span>
                </Link>
              ) : (
                <span aria-hidden />
              )}

              {showCtas && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(showDecision || showExpandVerb) && (
                    <CompactDecisionActions
                      item={item}
                      companyId={companyId}
                      ctas={decisionCtas}
                      onOpen={() => onToggleExpand(item)}
                    />
                  )}

                  {showOpen && (
                    <Button asChild size="sm">
                      <Link to={href!}>
                        {item.sourceKind === "review" ? "Review" : "Open"}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  )}

                  {showRestore && (
                    <Button type="button" variant="outline" size="sm" onClick={() => onRestore(item)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      Restore
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {inline && expanded && (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200">
          <InlineResolver
            item={item}
            companyId={companyId}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
          />
        </div>
      )}
    </div>
  );
});

type CompactDecisionAction = "accept" | "approve" | "reject";

/**
 * The one-tap decision pair a collapsed card can resolve in place. Labels are
 * fixed to the six-verb vocabulary (Approve / Reject) rather than echoing the
 * server verb labels, so "Approve" never drifts to "Accept"/"Confirm" between
 * sources — the expanded resolver still shows the full configured wording.
 * Approvals' third verb (Request revision) lives in the resolver only.
 */
interface CompactDecisionCtas {
  /** Solid advance verb ("Approve"), when the card has one. */
  advance: { action: "accept" | "approve" } | null;
  /** Outline counter-verb ("Reject"); confirmations collect a reason in the resolver. */
  counter: { viaResolver: boolean } | null;
}

function collectDecisionCtas(item: AttentionItem): CompactDecisionCtas | null {
  const has = (id: string) => item.decisionVerbs.some((verb) => verb.id === id);
  if (item.sourceKind === "approval" || item.sourceKind === "join_request") {
    if (!has("approve") && !has("reject")) return null;
    return {
      advance: has("approve") ? { action: "approve" } : null,
      counter: has("reject") ? { viaResolver: false } : null,
    };
  }
  if (
    item.sourceKind === "issue_thread_interaction"
    && item.subject.metadata?.kind === "request_confirmation"
  ) {
    if (!has("accept") && !has("reject")) return null;
    return {
      advance: has("accept") ? { action: "accept" } : null,
      counter: has("reject") ? { viaResolver: true } : null,
    };
  }
  return null;
}

/** Advance verb for inline cards that resolve through the expanded form. */
function expandVerbLabel(item: AttentionItem): "Answer" | "Review" {
  return item.subject.metadata?.kind === "ask_user_questions" ? "Answer" : "Review";
}

function CompactDecisionActions({
  item,
  companyId,
  ctas,
  onOpen,
}: {
  item: AttentionItem;
  companyId: string;
  ctas: CompactDecisionCtas | null;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const advance = ctas?.advance ?? null;
  const counter = ctas?.counter ?? null;

  const decision = useMutation<unknown, Error, CompactDecisionAction>({
    mutationFn: (action: CompactDecisionAction) => {
      if (item.sourceKind === "approval") {
        return action === "reject"
          ? approvalsApi.reject(item.subject.id)
          : approvalsApi.approve(item.subject.id);
      }
      if (item.sourceKind === "join_request") {
        return action === "reject"
          ? accessApi.rejectJoinRequest(companyId, item.subject.id)
          : accessApi.approveJoinRequest(companyId, item.subject.id);
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
        title: `Could not ${action === "reject" ? "reject" : "approve"}`,
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  return (
    <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Decision actions">
      {counter && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            if (counter.viaResolver) {
              onOpen();
              return;
            }
            decision.mutate("reject");
          }}
        >
          {decision.isPending && decision.variables === "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Reject
        </Button>
      )}
      {advance && (
        <Button
          type="button"
          size="sm"
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            decision.mutate(advance.action);
          }}
        >
          {decision.isPending && decision.variables !== "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Approve
        </Button>
      )}
      {!ctas && (
        <Button
          type="button"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {expandVerbLabel(item)}
        </Button>
      )}
    </div>
  );
}

function compactDecisionSuccessLabel(sourceKind: AttentionItem["sourceKind"], action: CompactDecisionAction): string {
  const outcome = action === "reject" ? "rejected" : "approved";
  if (sourceKind === "approval") return `Approval ${outcome}`;
  if (sourceKind === "join_request") return `Join request ${outcome}`;
  return action === "reject" ? "Confirmation declined" : "Confirmation accepted";
}

/**
 * Inline project identity keeps useful context without a competing badge.
 * The icon renders bare on the card background in the same gray as the name
 * (no colored tile — the project color stays on project-native surfaces),
 * and the whole pair links to the project.
 */
function ProjectMeta({ project }: { project: NonNullable<AttentionItem["project"]> }) {
  const Icon = getProjectIcon(project.icon);
  return (
    <Link
      to={projectUrl(project)}
      className="inline-flex max-w-(--sz-12rem) items-center gap-1.5 text-(length:--text-nano) text-muted-foreground hover:text-foreground"
      title={project.name}
      data-testid="attention-project-meta"
      onClick={(e) => e.stopPropagation()}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{project.name}</span>
    </Link>
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
