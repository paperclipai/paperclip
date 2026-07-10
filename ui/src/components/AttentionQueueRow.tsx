import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Folder,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  X,
} from "lucide-react";
import type { Agent, AttentionDetailImage, AttentionItem, AttentionProjectRef } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
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
  onToggleExpand: () => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze?: (item: AttentionItem, snoozedUntil: string) => void;
  /** Restore a snoozed/dismissed row (curtain variant only). */
  onRestore?: (item: AttentionItem) => void;
  /** Click-to-filter on the project chip (wires into the toolbar filter state). */
  onFilterProject?: (project: AttentionProjectRef) => void;
  /** "active" renders the live queue row; "hidden" renders a curtain row. */
  variant?: "active" | "hidden";
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}

export function AttentionQueueRow({
  item,
  companyId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onRestore,
  onFilterProject,
  variant = "active",
  agentMap,
  currentUserId,
  userLabelMap,
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
  const verbs = item.decisionVerbs.slice(0, 3);
  const workspaceLabel =
    item.workspace && item.workspace.name !== item.project?.name ? item.workspace.name : null;

  const activate = () => {
    if (expandable) onToggleExpand();
  };
  const onHeaderKeyDown = (e: KeyboardEvent) => {
    if (!expandable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleExpand();
    }
  };

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        "transition-colors hover:border-border/80",
        isHidden && "bg-muted/30 opacity-80 hover:opacity-100",
      )}
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
                {isHidden && snoozedUntil ? (
                  <span
                    className="ml-auto inline-flex items-center gap-1 text-(length:--text-nano) text-muted-foreground"
                    title={`Reappears ${new Date(snoozedUntil).toLocaleString()}`}
                  >
                    <AlarmClock className="h-3 w-3" />
                    Reappears {reappearLabel(snoozedUntil)}
                  </span>
                ) : (
                  <span className="ml-auto inline-flex items-center gap-1 text-(length:--text-nano) text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {relativeTime(item.activityAt)}
                  </span>
                )}
              </div>

              <div className="mt-1">
                <span className="block truncate text-sm font-medium text-foreground" title={item.subject.title ?? undefined}>
                  {item.subject.title ?? meta.label}
                </span>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</p>

                {(item.project || workspaceLabel) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {item.project && (
                      <Chip
                        icon={Folder}
                        label={item.project.name}
                        onClick={
                          onFilterProject
                            ? (e) => {
                                e.stopPropagation();
                                onFilterProject(item.project!);
                              }
                            : undefined
                        }
                      />
                    )}
                    {workspaceLabel && <Chip icon={Boxes} label={workspaceLabel} />}
                  </div>
                )}
              </div>
            </div>

            {images.length > 0 && <ThumbnailStack images={images} />}
          </div>
        </div>

        {/* Controls: kept as siblings (not inside the clickable header) so they
            never toggle expand and stay valid interactive targets. */}
        <div className="flex shrink-0 flex-col items-end self-end gap-1" data-attention-actions="true">
          {expandable && !expanded && verbs.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1" aria-label="Decision actions">
              {verbs.map((verb) => (
                <Button
                  key={verb.id}
                  type="button"
                  variant={decisionVerbVariant(verb)}
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand();
                  }}
                >
                  {verb.label}
                </Button>
              ))}
            </div>
          )}

          <div className="flex items-start justify-end gap-1">
            {!inline && href && (
              <Button asChild variant="outline" size="xs">
                <Link to={href}>
                  Open
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </Button>
            )}

            {isHidden ? (
              onRestore && (
                <Button type="button" variant="outline" size="xs" onClick={() => onRestore(item)}>
                  <RotateCcw className="h-3 w-3" />
                  Restore
                </Button>
              )
            ) : (
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
      </div>

      {inline && expanded && (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
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
}

function decisionVerbVariant(verb: AttentionItem["decisionVerbs"][number]): "default" | "outline" | "destructive" {
  const text = `${verb.id} ${verb.label}`.toLowerCase();
  if (/\b(reject|decline|deny|delete|remove)\b/.test(text)) return "destructive";
  if (/\b(accept|approve|confirm|apply)\b/.test(text)) return "default";
  return "outline";
}

/** Small pill used for the project / workspace chips. Clickable when `onClick`. */
function Chip({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Folder;
  label: string;
  onClick?: (e: MouseEvent) => void;
}) {
  const className = cn(
    "inline-flex max-w-(--sz-12rem) items-center gap-1 rounded-sm border border-border/70 bg-muted/40 px-1.5 py-0.5 text-(length:--text-nano) text-muted-foreground",
    onClick && "transition-colors hover:border-border hover:bg-accent hover:text-foreground",
  );
  const content = (
    <>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={`Filter by ${label}`}>
        {content}
      </button>
    );
  }
  return <span className={className}>{content}</span>;
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
