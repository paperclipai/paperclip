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
  const tone = attentionToneStyle(item);
  const sevBadge = severityBadge(item.severity);
  const Icon = meta.icon;
  const isHidden = variant === "hidden";
  const inline = !isHidden && isInlineResolvable(item);
  const href = item.subject.href;
  const snoozedUntil = item.dismissal?.kind === "snooze" ? item.dismissal.snoozedUntil : null;
  const detailLine = attentionDetailLine(item) ?? item.whyNow;
  const images = attentionDetailImages(item);
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

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden border border-border bg-card",
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

      <div className="flex items-start gap-3 py-3 pl-4 pr-3">
        {/* Clickable header region: toggles expand for inline rows (plan §2/§5). */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3 rounded-md",
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
          {/* Expand affordance / source icon */}
          {expandable ? (
            <span className="mt-0.5 shrink-0 p-0.5 text-muted-foreground" aria-hidden>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
          ) : (
            <span className="mt-0.5 shrink-0 p-0.5" aria-hidden>
              <Icon className={cn("h-4 w-4", tone.icon)} />
            </span>
          )}

          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
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

              <div className="mt-1">
                <span className="block truncate text-sm font-medium text-foreground" title={item.subject.title ?? undefined}>
                  {item.subject.title ?? meta.label}
                </span>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</p>

                {item.project && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <ProjectMeta project={item.project} />
                  </div>
                )}
              </div>
            </div>

            {images.length > 0 && <ThumbnailStack images={images} />}
          </div>
        </div>

        {/* Controls: kept as siblings (not inside the clickable header) so they
            never toggle expand and stay valid interactive targets. */}
        <div className="flex shrink-0 self-stretch flex-col items-end justify-between gap-2" data-attention-controls="true">
          <div className="flex items-center justify-end gap-1" data-attention-menu="true">
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

          <div className="mt-auto flex flex-col items-end gap-1" data-attention-actions="true">
            {!expanded && <CompactDecisionActions item={item} companyId={companyId} onOpen={() => onToggleExpand(item)} />}

            <div className="flex items-start justify-end gap-1">
              {!inline && href && (
                <Button asChild variant="outline" size="xs">
                  <Link to={href}>
                    Open
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </Button>
              )}

              {isHidden && onRestore && (
                <Button type="button" variant="outline" size="xs" onClick={() => onRestore(item)}>
                  <RotateCcw className="h-3 w-3" />
                  Restore
                </Button>
              )}
            </div>
          </div>
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
  const actions = item.decisionVerbs
    .slice(0, 3)
    .flatMap((verb) => {
      const action = compactDecisionAction(item, verb.id);
      return action ? [{ action, label: verb.label, id: verb.id }] : [];
    });

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
    <div className="flex flex-wrap justify-end gap-1" aria-label="Decision actions">
      {actions.map(({ action, id, label }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description: "" })}
          size="xs"
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
        {visible.map((img, i) => (
          <img
            key={img.assetId}
            src={attentionImageUrl(img.assetId)}
            alt={img.alt ?? ""}
            loading="lazy"
            style={{ zIndex: visible.length - i }}
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
