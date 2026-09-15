import { useMemo, useRef, useState, useEffect } from "react";
import type {
  DocumentAnnotationComment,
  DocumentAnnotationThreadWithComments,
} from "@paperclipai/shared";
import {
  Check,
  Copy,
  MoreHorizontal,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, relativeTime } from "@/lib/utils";
import type { DocumentAnnotationTarget } from "@/api/document-annotations";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AgentIcon } from "./AgentIconPicker";
import { deriveInitials } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";
import type { PendingAnchor } from "./DocumentAnnotationLayer";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "@/lib/company-members";
import { useDocumentAnnotationMutations } from "@/hooks/useDocumentAnnotationMutations";

export interface AnnotationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: DocumentAnnotationTarget;
  issueId?: string;
  documentKey: string;
  documentRevisionNumber: number;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  threads: DocumentAnnotationThreadWithComments[];
  focusedThreadId: string | null;
  onFocusThread: (threadId: string | null) => void;
  focusedCommentId: string | null;
  /** External pending anchor captured from the layer for the composer. */
  pendingAnchor: PendingAnchor | null;
  onClearPendingAnchor: () => void;
  /** Request the body layer to start a comment from the current text selection (⌘⇧M). */
  onRequestCommentFromSelection?: () => void;
  newCommentDisabled?: boolean;
  newCommentDisabledReason?: string | null;
  /** When mobile is true, render via shadcn Sheet at the bottom instead of side panel. */
  isMobile?: boolean;
  /** Desktop panel width calculated by the document frame. */
  desktopWidth?: number;
  /** Render as a full-width card in a constrained host instead of a floating side panel. */
  inline?: boolean;
  className?: string;
  /** Resolve `<authorAgentId>` to a display name. */
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  /** Resolve `<authorUserId>` to a display name. */
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}

export function DocumentAnnotationPanel(props: AnnotationPanelProps) {
  if (props.isMobile) {
    return (
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="paperclip-doc-annotation-sheet z-(--z-60) flex max-h-(--sz-88vh) flex-col rounded-none border-t border-border bg-popover p-0 text-popover-foreground shadow-2xl"
        >
          <SheetTitle className="sr-only">
            Comments on {props.documentKey} revision {props.documentRevisionNumber}
          </SheetTitle>
          <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          <AnnotationPanelBody {...props} />
        </SheetContent>
      </Sheet>
    );
  }

  if (!props.open) return null;

  return (
    <aside
      role="complementary"
      aria-label={`Annotations for ${props.documentKey.toUpperCase()}, revision ${props.documentRevisionNumber}`}
      data-testid="document-annotation-panel"
      className={cn(
        "isolate flex h-full max-h-(--sz-80vh) shrink-0 flex-col overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-xl",
        props.inline ? "w-full" : "w-(--sz-360px)",
        props.className,
      )}
      style={props.desktopWidth ? { width: props.desktopWidth, maxWidth: props.desktopWidth } : undefined}
    >
      <AnnotationPanelBody {...props} />
    </aside>
  );
}

export function AnnotationPanelBody(props: AnnotationPanelProps) {
  const [composerValue, setComposerValue] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyTestId = props.isMobile ? "document-annotation-panel" : undefined;
  const annotationTarget = useMemo<DocumentAnnotationTarget>(() => {
    if (props.target) return props.target;
    if (!props.issueId) throw new Error("Document annotation panel requires an annotation target.");
    return { kind: "issue", issueId: props.issueId, documentKey: props.documentKey };
  }, [props.documentKey, props.issueId, props.target]);

  const { createThread, addReply, updateStatus, mutationError, currentUser } = useDocumentAnnotationMutations({
    target: annotationTarget,
    baseRevisionId: props.baseRevisionId,
    baseRevisionNumber: props.baseRevisionNumber,
    pendingAnchor: props.pendingAnchor,
    onFocusThread: props.onFocusThread,
    onThreadCreated: () => {
      props.onClearPendingAnchor();
      setComposerValue("");
    },
    onReplyAdded: (threadId) => setReplyDrafts((current) => ({ ...current, [threadId]: "" })),
  });

  // Show every thread that can be anchored in the document (orphaned threads have
  // lost their anchor). Filters were removed in favour of a single simple list.
  // Sort in document order (top-to-bottom) — not by recency — so the comment list
  // stays congruent with the highlights as you scroll the document.
  const visibleThreads = useMemo(
    () =>
      props.threads
        .filter((thread) => thread.anchorState !== "orphaned")
        .sort((a, b) =>
          (a.normalizedStart - b.normalizedStart)
          || (a.markdownStart - b.markdownStart)
          || (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())),
    [props.threads],
  );


  useEffect(() => {
    if (!props.open) {
      setComposerValue("");
    }
  }, [props.open]);

  useEffect(() => {
    if (props.pendingAnchor && props.open) {
      composerRef.current?.focus();
    }
  }, [props.open, props.pendingAnchor]);

  // Keep the comment list congruent with the document: when a thread becomes
  // focused — whether by clicking its highlight in the doc or by adding a new
  // comment — scroll that card into view in the pane.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.focusedThreadId) return;
    const container = listScrollRef.current;
    if (!container) return;
    const card = container.querySelector<HTMLElement>(
      `[data-thread-id="${props.focusedThreadId}"]`,
    );
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [props.focusedThreadId, visibleThreads]);

  return (
    <>
      <div
        data-testid={bodyTestId}
        className="flex items-center justify-end gap-1 border-b border-border bg-popover px-2 py-1.5"
      >
        <span className="text-(length:--text-micro) tabular-nums text-muted-foreground">
          rev {props.documentRevisionNumber}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => {
            props.onFocusThread(null);
            props.onOpenChange(false);
          }}
          aria-label="Close annotation panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {props.newCommentDisabled && props.newCommentDisabledReason ? (
        <p
          data-testid="document-annotation-disabled-reason"
          className="border-b border-border bg-muted px-3 py-1.5 text-(length:--text-micro) text-muted-foreground"
        >
          {props.newCommentDisabledReason}
        </p>
      ) : null}
      {mutationError ? (
        <p
          data-testid="document-annotation-error"
          className="border-b border-border bg-destructive/10 px-3 py-1.5 text-(length:--text-micro) text-destructive"
        >
          {mutationError}
        </p>
      ) : null}
      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto bg-popover px-3 py-2">
        {visibleThreads.length === 0 ? null : (
          <ul className="space-y-2">
            {visibleThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                expanded={thread.id === props.focusedThreadId}
                focusedCommentId={
                  thread.id === props.focusedThreadId ? props.focusedCommentId : null
                }
                onFocus={() => props.onFocusThread(thread.id)}
                replyDraft={replyDrafts[thread.id] ?? ""}
                onReplyChange={(value) =>
                  setReplyDrafts((current) => ({ ...current, [thread.id]: value }))
                }
                onSubmitReply={() => {
                  const body = (replyDrafts[thread.id] ?? "").trim();
                  if (!body) return;
                  addReply.mutate({ threadId: thread.id, body });
                }}
                onResolveToggle={() =>
                  updateStatus.mutate({
                    threadId: thread.id,
                    status: thread.status === "resolved" ? "open" : "resolved",
                  })
                }
                onCopyLink={() => copyAnnotationLink(props.documentKey, thread.id)}
                pendingReply={addReply.isPending && addReply.variables?.threadId === thread.id}
                pendingStatus={updateStatus.isPending && updateStatus.variables?.threadId === thread.id}
                agentMap={props.agentMap}
                userProfileMap={props.userProfileMap}
              />
            ))}
          </ul>
        )}
      </div>
      {props.pendingAnchor ? (
        <div className="border-t border-border bg-popover px-3 py-2">
          <blockquote className="mb-2 line-clamp-2 overflow-hidden rounded-none bg-muted px-2 py-1 text-xs italic leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {truncate(props.pendingAnchor.selectedText, 160)}
          </blockquote>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Avatar size="xs" className="shrink-0">
              {currentUser.image ? <AvatarImage src={currentUser.image} alt={currentUser.name} /> : null}
              <AvatarFallback>{deriveInitials(currentUser.name)}</AvatarFallback>
            </Avatar>
            <span className="truncate text-(length:--text-micro) font-medium text-foreground">{currentUser.name}</span>
          </div>
          <Textarea
            ref={composerRef}
            data-testid="document-annotation-composer"
            rows={3}
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                const body = composerValue.trim();
                if (
                  body
                  && !createThread.isPending
                  && !props.newCommentDisabled
                  && props.baseRevisionId
                ) {
                  createThread.mutate(body);
                }
              }
            }}
            placeholder="Write a comment…"
            disabled={props.newCommentDisabled}
            className="resize-y rounded-none text-sm"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                props.onClearPendingAnchor();
                setComposerValue("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                createThread.isPending
                || !composerValue.trim()
                || props.newCommentDisabled
                || !props.baseRevisionId
              }
              onClick={() => createThread.mutate(composerValue.trim())}
            >
              {createThread.isPending ? "Posting…" : "Comment"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ThreadCard(props: {
  thread: DocumentAnnotationThreadWithComments;
  expanded: boolean;
  focusedCommentId: string | null;
  onFocus: () => void;
  replyDraft: string;
  onReplyChange: (value: string) => void;
  onSubmitReply: () => void;
  onResolveToggle: () => void;
  onCopyLink: () => void;
  pendingReply: boolean;
  pendingStatus: boolean;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}) {
  const { thread } = props;
  const latestComment = thread.comments[thread.comments.length - 1];

  return (
    <li>
      <article
        role="article"
        data-thread-id={thread.id}
        data-anchor-state={thread.anchorState}
        data-status={thread.status}
        data-focused={props.expanded || undefined}
        aria-labelledby={`thread-quote-${thread.id}`}
        className={cn(
          "scroll-mt-2 rounded-none border border-border bg-background transition-colors",
          props.expanded && "ring-2 ring-primary/80 ring-offset-1 ring-offset-popover",
          thread.status === "resolved" && "bg-muted",
        )}
        tabIndex={0}
        onClick={props.onFocus}
      >
        <blockquote
          id={`thread-quote-${thread.id}`}
          className={cn(
            "mx-3 mt-2 line-clamp-2 overflow-hidden rounded-none bg-muted px-2 py-1 text-xs italic leading-5 text-muted-foreground [overflow-wrap:anywhere]",
            (thread.anchorState === "stale" || thread.status === "resolved") && "bg-muted",
          )}
        >
          {truncate(thread.selectedText, 120)}
        </blockquote>
        {props.expanded ? (
          <div className="space-y-2 px-3 py-2">
            {thread.comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                focused={props.focusedCommentId === comment.id}
                agentMap={props.agentMap}
                userProfileMap={props.userProfileMap}
              />
            ))}
            <Textarea
              data-testid={`document-annotation-reply-${thread.id}`}
              rows={2}
              value={props.replyDraft}
              onChange={(event) => props.onReplyChange(event.target.value)}
              onKeyDown={(event) => {
                if (isSubmitShortcut(event)) {
                  event.preventDefault();
                  if (props.replyDraft.trim() && !props.pendingReply) {
                    props.onSubmitReply();
                  }
                }
              }}
              placeholder="Reply…"
              className="resize-y rounded-none text-sm"
              disabled={props.pendingReply}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={props.onResolveToggle}
                disabled={props.pendingStatus}
                className="gap-1"
              >
                {thread.status === "resolved" ? (
                  <>
                    <RotateCcw className="h-3 w-3" /> Reopen
                  </>
                ) : (
                  <>
                    <Check className="h-3 w-3" /> Resolve
                  </>
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!props.replyDraft.trim() || props.pendingReply}
                onClick={props.onSubmitReply}
              >
                {props.pendingReply ? "Sending…" : "Reply"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    title="More actions"
                    aria-label="More thread actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(event) => {
                      event.preventDefault();
                      props.onCopyLink();
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy link
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
            </span>
            {latestComment ? <span className="ml-1">· {truncate(latestComment.body, 120)}</span> : null}
          </p>
        )}
      </article>
    </li>
  );
}

function CommentRow({
  comment,
  focused,
  agentMap,
  userProfileMap,
}: {
  comment: DocumentAnnotationComment;
  focused: boolean;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}) {
  const author = resolveAuthor(comment, { agentMap, userProfileMap });
  return (
    <div
      id={`comment-${comment.id}`}
      data-focused={focused || undefined}
      className={cn(
        "rounded-none border border-border bg-background px-2 py-1.5",
        focused && "ring-2 ring-primary/40",
      )}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2 text-(length:--text-micro)">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar size="xs" className="shrink-0">
            {author.role === "agent" ? (
              <AvatarFallback>
                <AgentIcon icon={author.agentIcon} className="h-3 w-3" />
              </AvatarFallback>
            ) : (
              <>
                {author.imageUrl ? <AvatarImage src={author.imageUrl} alt={author.name} /> : null}
                <AvatarFallback>{deriveInitials(author.name)}</AvatarFallback>
              </>
            )}
          </Avatar>
          <span className="truncate font-medium text-foreground">{author.name}</span>
          {author.role === "agent" ? (
            <span className="text-muted-foreground">· agent</span>
          ) : null}
        </span>
        <span className="shrink-0 text-muted-foreground">{relativeTime(comment.createdAt)}</span>
      </div>
      <MarkdownBody className="text-sm leading-6">{comment.body}</MarkdownBody>
    </div>
  );
}

/** ⌘/Ctrl + Enter submits the composer or reply. */
function isSubmitShortcut(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

function resolveAuthor(
  comment: DocumentAnnotationComment,
  maps: {
    agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
    userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
  },
): { name: string; role: "board" | "agent"; agentIcon?: Agent["icon"]; imageUrl?: string | null } {
  if (comment.authorAgentId) {
    const agent = maps.agentMap?.get(comment.authorAgentId);
    return {
      name: agent?.name ?? comment.authorAgentId.slice(0, 8),
      role: "agent",
      agentIcon: agent?.icon,
    };
  }
  if (comment.authorUserId) {
    const profile = maps.userProfileMap?.get(comment.authorUserId);
    return {
      name: profile?.label ?? comment.authorUserId.slice(0, 8),
      role: "board",
      imageUrl: profile?.image ?? null,
    };
  }
  return { name: comment.authorType === "agent" ? "Agent" : "Board", role: comment.authorType === "agent" ? "agent" : "board" };
}

export function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export async function copyAnnotationLink(documentKey: string, threadId: string) {
  if (typeof window === "undefined") return;
  const { pathname } = window.location;
  const hash = `#document-${encodeURIComponent(documentKey)}&thread=${encodeURIComponent(threadId)}`;
  try {
    await copyTextToClipboard(`${window.location.origin}${pathname}${hash}`);
  } catch {
    /* swallow */
  }
}
