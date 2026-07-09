import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { isInlineResolvable, severityStyle, sourceMeta } from "../lib/attention";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";

interface AttentionQueueRowProps {
  item: AttentionItem;
  companyId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onDismiss: (item: AttentionItem) => void;
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
  agentMap,
  currentUserId,
  userLabelMap,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  const severity = severityStyle(item.severity);
  const Icon = meta.icon;
  const inline = isInlineResolvable(item);
  const href = item.subject.href;

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        "transition-colors hover:border-border/80",
      )}
      data-attention-source={item.sourceKind}
      data-attention-severity={item.severity}
    >
      {/* Severity accent bar */}
      <span className={cn("absolute inset-y-0 left-0 w-1", severity.accent)} aria-hidden />

      <div className="flex items-start gap-3 py-3 pl-4 pr-3">
        {/* Expand affordance / source icon */}
        {inline ? (
          <button
            type="button"
            onClick={onToggleExpand}
            className="mt-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring focus-visible:ring-[3px]"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse decision" : "Expand decision"}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="mt-0.5 shrink-0 p-0.5" aria-hidden>
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </span>
            {item.relatedIssue?.identifier && (
              <Link
                to={item.relatedIssue.href ?? "#"}
                className="font-mono text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                {item.relatedIssue.identifier}
              </Link>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-(length:--text-nano) text-muted-foreground">
              <Clock className="h-3 w-3" />
              {relativeTime(item.activityAt)}
            </span>
          </div>

          <div className="mt-1 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {href ? (
                <Link
                  to={href}
                  className="block truncate text-sm font-medium text-foreground hover:underline"
                  title={item.subject.title ?? undefined}
                >
                  {item.subject.title ?? meta.label}
                </Link>
              ) : (
                <span className="block truncate text-sm font-medium text-foreground">
                  {item.subject.title ?? meta.label}
                </span>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">{item.whyNow}</p>
            </div>

            {/* Deep-link / open for non-inline rows */}
            {!inline && href && (
              <Button asChild variant="outline" size="xs" className="shrink-0">
                <Link to={href}>
                  Open
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </Button>
            )}

            {/* Snooze / dismiss */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground"
                  aria-label="Row actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onDismiss(item)}>Snooze / dismiss</DropdownMenuItem>
                {href && (
                  <DropdownMenuItem asChild>
                    <Link to={href}>Open source</Link>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
        className="min-h-[64px] text-sm"
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
