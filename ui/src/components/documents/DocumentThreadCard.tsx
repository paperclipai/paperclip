import { useState } from "react";
import { AlertTriangle, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn, relativeTime } from "@/lib/utils";
import {
  resolveReviewAuthor,
  type ReviewAuthorMaps,
  type ReviewAuthorRef,
} from "@/lib/document-review-authors";

export type RailThreadKind = "anchored" | "overall";
export type RailAnchorState = "active" | "stale" | "orphaned" | null;

export interface RailComment extends ReviewAuthorRef {
  id: string;
  body: string;
  createdAt: Date | string;
}

export interface RailThread {
  id: string;
  kind: RailThreadKind;
  status: "open" | "resolved";
  anchorState: RailAnchorState;
  selectedText: string | null;
  comments: RailComment[];
}

function stateBadge(thread: RailThread): { label: string; className: string; icon?: typeof AlertTriangle } {
  if (thread.kind === "overall") {
    return {
      label: "Overall feedback",
      className: "border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
    };
  }
  if (thread.anchorState === "orphaned") {
    return {
      label: "Orphaned",
      className: "border-transparent bg-muted text-muted-foreground",
      icon: Unlink,
    };
  }
  if (thread.anchorState === "stale") {
    return {
      label: "Stale",
      className: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
      icon: AlertTriangle,
    };
  }
  if (thread.status === "resolved") {
    // Spec §5.4: badge color matches the body highlight. The resolved highlight
    // is a muted/low-sat yellow, so the badge is muted yellow (not green).
    return {
      label: "Resolved",
      className: "border-transparent bg-yellow-50 text-yellow-700/80 dark:bg-yellow-950/40 dark:text-yellow-200/70",
    };
  }
  return {
    label: "Open",
    className: "border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300",
  };
}

export interface DocumentThreadCardProps {
  thread: RailThread;
  focused?: boolean;
  canReview: boolean;
  authorMaps?: ReviewAuthorMaps;
  onFocus?: (threadId: string) => void;
  onReply: (thread: RailThread, body: string) => Promise<void> | void;
  onToggleResolved: (thread: RailThread, resolved: boolean) => Promise<void> | void;
}

/**
 * Review-rail card for an anchored comment thread, a document-level overall
 * comment, stale/orphaned anchors. Renders the status badge, anchored snippet,
 * the comment thread, a reply composer, and a Resolve/Reopen toggle.
 */
export function DocumentThreadCard({
  thread,
  focused,
  canReview,
  authorMaps,
  onFocus,
  onReply,
  onToggleResolved,
}: DocumentThreadCardProps) {
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState<null | "reply" | "resolve">(null);
  const badge = stateBadge(thread);
  const BadgeIcon = badge.icon;

  const handleReply = async () => {
    const trimmed = reply.trim();
    if (!trimmed) return;
    setPending("reply");
    try {
      await onReply(thread, trimmed);
      setReply("");
    } finally {
      setPending(null);
    }
  };

  const handleToggle = async () => {
    setPending("resolve");
    try {
      await onToggleResolved(thread, thread.status !== "resolved");
    } finally {
      setPending(null);
    }
  };

  return (
    <article
      role="article"
      data-testid={`thread-card-${thread.id}`}
      data-status={thread.status}
      data-anchor-state={thread.anchorState ?? undefined}
      data-focused={focused || undefined}
      className={cn(
        "rounded-md border border-border bg-card p-2.5 text-card-foreground shadow-sm",
        focused && "border-l-2 border-l-primary",
      )}
      onClick={() => onFocus?.(thread.id)}
    >
      <header className="mb-1.5 flex items-center justify-between gap-2">
        <Badge className={cn("gap-1 px-1.5 py-0 text-[10px] font-medium", badge.className)}>
          {BadgeIcon ? <BadgeIcon className="h-3 w-3" aria-hidden="true" /> : null}
          {badge.label}
        </Badge>
      </header>

      {thread.kind === "anchored" && thread.selectedText ? (
        <p
          id={`thread-quote-${thread.id}`}
          className={cn(
            "mb-2 border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground",
            thread.anchorState === "stale" && "border-amber-400",
            thread.anchorState === "orphaned" && "border-dashed",
          )}
        >
          “{thread.selectedText}”
        </p>
      ) : null}

      <div className="space-y-1.5">
        {thread.comments.map((comment) => {
          const author = resolveReviewAuthor(comment, authorMaps ?? {});
          return (
            <div key={comment.id} className="rounded border border-border bg-background px-2 py-1">
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-foreground">{author.name}</span>
                  {author.role === "agent" ? <span className="ml-1 text-muted-foreground">· agent</span> : null}
                </span>
                <span className="text-muted-foreground">{relativeTime(comment.createdAt)}</span>
              </div>
              <MarkdownBody className="text-sm leading-6">{comment.body}</MarkdownBody>
            </div>
          );
        })}
      </div>

      {canReview ? (
        <div className="mt-2 space-y-2">
          <Textarea
            data-testid={`thread-reply-${thread.id}`}
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
            placeholder="Reply…"
            rows={2}
            className="min-h-[2.25rem] resize-none text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            {reply.trim() ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={pending != null}
                onClick={handleReply}
              >
                Reply
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending != null}
              onClick={handleToggle}
              data-testid={`thread-resolve-${thread.id}`}
            >
              {thread.status === "resolved" ? "Reopen" : "Resolve"}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
