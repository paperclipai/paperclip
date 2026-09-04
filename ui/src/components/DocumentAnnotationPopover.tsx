import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, DocumentAnnotationThreadWithComments } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentAnnotationTarget } from "@/api/document-annotations";
import type { CompanyUserProfile } from "@/lib/company-members";
import { useDocumentAnnotationMutations } from "@/hooks/useDocumentAnnotationMutations";
import type { AnnotationAnchorRect, PendingAnchor } from "./DocumentAnnotationLayer";
import { copyAnnotationLink, ThreadCard, truncate } from "./DocumentAnnotationPanel";

export interface DocumentAnnotationPopoverProps {
  anchorRect: AnnotationAnchorRect;
  containerRef: React.RefObject<HTMLElement | null>;
  target: DocumentAnnotationTarget;
  documentKey: string;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  pendingAnchor: PendingAnchor | null;
  thread: DocumentAnnotationThreadWithComments | null;
  focusedCommentId: string | null;
  onFocusThread: (threadId: string | null) => void;
  onClose: () => void;
  onThreadCreated: (thread: DocumentAnnotationThreadWithComments) => void;
  newCommentDisabled?: boolean;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}

export function DocumentAnnotationPopover(props: DocumentAnnotationPopoverProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [composer, setComposer] = useState("");
  const [reply, setReply] = useState("");
  const target = useMemo(() => props.target, [props.target]);
  const { createThread, addReply, updateStatus, mutationError } = useDocumentAnnotationMutations({
    target,
    baseRevisionId: props.baseRevisionId,
    baseRevisionNumber: props.baseRevisionNumber,
    pendingAnchor: props.pendingAnchor,
    onFocusThread: props.onFocusThread,
    onThreadCreated: props.onThreadCreated,
    onReplyAdded: () => setReply(""),
  });

  useEffect(() => composerRef.current?.focus(), [props.pendingAnchor]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) props.onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [props.onClose]);

  const cardHeight = cardRef.current?.offsetHeight ?? 260;
  const containerHeight = visibleBottomWithinContainer(props.containerRef.current);
  const below = props.anchorRect.top + props.anchorRect.height + 6;
  const top = below + cardHeight <= containerHeight
    ? below
    : Math.max(0, props.anchorRect.top - cardHeight - 6);
  const containerWidth = props.containerRef.current?.clientWidth ?? 320;
  const left = Math.max(0, Math.min(props.anchorRect.left, containerWidth - 320));
  const submitComposer = () => {
    const body = composer.trim();
    if (body && !createThread.isPending && props.baseRevisionId) createThread.mutate(body);
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={props.pendingAnchor ? "Add annotation comment" : "Annotation thread"}
      data-testid="document-annotation-popover"
      className="absolute z-(--z-20) w-80 max-w-full rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
      style={{ top, left }}
    >
      {mutationError ? <p className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">{mutationError}</p> : null}
      {props.pendingAnchor ? (
        <div className="p-3">
          <blockquote className="mb-2 line-clamp-2 rounded-md bg-muted px-2 py-1 text-xs italic text-muted-foreground">
            {truncate(props.pendingAnchor.selectedText, 120)}
          </blockquote>
          <Textarea
            ref={composerRef}
            data-testid="document-annotation-popover-composer"
            rows={3}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitComposer();
              }
            }}
            placeholder="Write a comment…"
            disabled={props.newCommentDisabled || createThread.isPending}
            className="resize-y text-sm"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>Cancel</Button>
            <Button type="button" size="sm" disabled={!composer.trim() || createThread.isPending || props.newCommentDisabled || !props.baseRevisionId} onClick={submitComposer}>
              {createThread.isPending ? "Posting…" : "Comment"}
            </Button>
          </div>
        </div>
      ) : props.thread ? (
        <ul className="p-2">
          <ThreadCard
            thread={props.thread}
            expanded
            focusedCommentId={props.focusedCommentId}
            onFocus={() => props.onFocusThread(props.thread!.id)}
            replyDraft={reply}
            onReplyChange={setReply}
            onSubmitReply={() => {
              const body = reply.trim();
              if (body) addReply.mutate({ threadId: props.thread!.id, body });
            }}
            onResolveToggle={() => updateStatus.mutate({ threadId: props.thread!.id, status: props.thread!.status === "resolved" ? "open" : "resolved" })}
            onCopyLink={() => copyAnnotationLink(props.documentKey, props.thread!.id)}
            pendingReply={addReply.isPending}
            pendingStatus={updateStatus.isPending}
            agentMap={props.agentMap}
            userProfileMap={props.userProfileMap}
          />
        </ul>
      ) : null}
    </div>
  );
}

function visibleBottomWithinContainer(container: HTMLElement | null): number {
  if (!container || typeof window === "undefined") return Number.POSITIVE_INFINITY;
  const containerRect = container.getBoundingClientRect();
  let visibleBottom = window.innerHeight;
  let parent = container.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if ([style.overflow, style.overflowY].some((value) => value === "auto" || value === "scroll" || value === "hidden" || value === "clip")) {
      visibleBottom = Math.min(visibleBottom, parent.getBoundingClientRect().bottom);
    }
    parent = parent.parentElement;
  }
  return visibleBottom - containerRect.top;
}
