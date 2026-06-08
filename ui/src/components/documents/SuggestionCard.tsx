import { useState } from "react";
import type {
  DocumentSuggestionKind,
  DocumentSuggestionWithComments,
} from "@paperclipai/shared";
import { AlertTriangle, Check, CheckCheck, MoreHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn, relativeTime } from "@/lib/utils";
import {
  resolveReviewAuthor,
  type ReviewAuthorMaps,
} from "@/lib/document-review-authors";

const KIND_LABEL: Record<DocumentSuggestionKind, string> = {
  insertion: "Insert",
  deletion: "Delete",
  substitution: "Replace",
};

// Insert/delete badges read the same §5.4 tokens the inline diff body uses, so a
// future token change propagates to both. Substitution has no dedicated token
// (it composes insert + delete), so it keeps the amber pairing.
const KIND_BADGE_CLASS: Record<DocumentSuggestionKind, string> = {
  insertion:
    "border-transparent bg-[var(--paperclip-doc-suggestion-insert-bg)] text-[var(--paperclip-doc-suggestion-insert-fg)]",
  deletion:
    "border-transparent bg-[var(--paperclip-doc-suggestion-delete-bg)] text-[var(--paperclip-doc-suggestion-delete-fg)]",
  substitution: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
};

export interface SuggestionCardProps {
  suggestion: DocumentSuggestionWithComments;
  /** Latest revision of the document; drives the "Needs rebase" gate. */
  latestRevisionId: string | null;
  /** Whether the viewer can accept/reject (board reviewer with edit rights). */
  canReview: boolean;
  authorMaps?: ReviewAuthorMaps;
  onAccept: (suggestion: DocumentSuggestionWithComments) => Promise<void> | void;
  onReject: (suggestion: DocumentSuggestionWithComments, reason: string) => Promise<void> | void;
  /**
   * Resolve without accepting or rejecting — "handled outside / no longer
   * applies". The safety valve when Accept is gated on a rebase and Reject would
   * falsely imply disagreement. No reason required.
   */
  onResolve?: (suggestion: DocumentSuggestionWithComments) => Promise<void> | void;
  onReply: (suggestion: DocumentSuggestionWithComments, body: string) => Promise<void> | void;
  /** Opens the diff modal for the revision this suggestion would produce. */
  onViewDiff?: (suggestion: DocumentSuggestionWithComments) => void;
  className?: string;
}

/**
 * NEW review-rail card for a suggested edit (insert / delete / replace).
 * Composes Badge + author chip + an inline CriticMarkup-style source/proposed
 * diff, a discussion thread, a reply composer, and Accept/Reject actions.
 *
 * Accept disables on a stale `baseRevisionId` (the suggestion was anchored to an
 * older revision) or a drifted/lost anchor — surfaced as a "Needs rebase" badge.
 */
export function SuggestionCard({
  suggestion,
  latestRevisionId,
  canReview,
  authorMaps,
  onAccept,
  onReject,
  onResolve,
  onReply,
  onViewDiff,
  className,
}: SuggestionCardProps) {
  const [reply, setReply] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<null | "accept" | "reject" | "resolve" | "reply">(null);

  const author = resolveReviewAuthor(suggestion, authorMaps ?? {});
  const kindLabel = KIND_LABEL[suggestion.kind];
  const isPending = suggestion.status === "pending";

  // Needs rebase when the suggestion's anchor revision lags the document, or the
  // anchor drifted/was lost during a remap. Accepting then would apply against a
  // mismatched base, so the backend rejects it — gate the button instead.
  const anchorDrifted = suggestion.anchorState !== "active";
  const revisionDrifted =
    latestRevisionId != null && suggestion.currentRevisionId != null
      ? suggestion.currentRevisionId !== latestRevisionId
      : false;
  const needsRebase = isPending && (anchorDrifted || revisionDrifted);
  const acceptDisabled = pending != null || needsRebase;

  const handleAccept = async () => {
    setPending("accept");
    try {
      await onAccept(suggestion);
    } finally {
      setPending(null);
    }
  };

  const handleReject = async () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setPending("reject");
    try {
      await onReject(suggestion, trimmed);
      setRejecting(false);
      setReason("");
    } finally {
      setPending(null);
    }
  };

  const handleResolve = async () => {
    if (!onResolve) return;
    setPending("resolve");
    try {
      await onResolve(suggestion);
    } finally {
      setPending(null);
    }
  };

  const handleReply = async () => {
    const trimmed = reply.trim();
    if (!trimmed) return;
    setPending("reply");
    try {
      await onReply(suggestion, trimmed);
      setReply("");
    } finally {
      setPending(null);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <article
        data-testid={`suggestion-card-${suggestion.id}`}
        data-kind={suggestion.kind}
        data-status={suggestion.status}
        className={cn(
          "rounded-md border border-border bg-card p-2.5 text-card-foreground shadow-sm",
          (suggestion.status === "rejected" || suggestion.status === "resolved") && "opacity-70",
          className,
        )}
      >
        <header className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge className={cn("px-1.5 py-0 text-[10px] font-semibold uppercase", KIND_BADGE_CLASS[suggestion.kind])}>
              {kindLabel}
            </Badge>
            {needsRebase ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    data-testid={`suggestion-needs-rebase-${suggestion.id}`}
                    className="gap-1 border-transparent bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    Needs rebase
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Document changed since this was suggested. Reload and review again, or rebase the
                  suggestion onto the latest revision.
                </TooltipContent>
              </Tooltip>
            ) : null}
            {suggestion.status === "accepted" ? (
              <Badge className="border-transparent bg-green-100 px-1.5 py-0 text-[10px] text-green-700 dark:bg-green-900/50 dark:text-green-300">
                Accepted
              </Badge>
            ) : null}
            {suggestion.status === "rejected" ? (
              <Badge className="border-transparent bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">
                Rejected
              </Badge>
            ) : null}
            {suggestion.status === "resolved" ? (
              <Badge
                data-testid={`suggestion-resolved-${suggestion.id}`}
                className="gap-1 border-transparent bg-muted px-1.5 py-0 text-[10px] text-muted-foreground"
              >
                <CheckCheck className="h-3 w-3" aria-hidden="true" />
                Resolved
              </Badge>
            ) : null}
          </div>
          {onViewDiff ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="View suggestion diff"
              title="View diff"
              onClick={() => onViewDiff(suggestion)}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </header>

        <p className="mb-2 text-[11px] text-muted-foreground">
          Suggested by <span className="font-medium text-foreground">{author.name}</span>
          {author.role === "agent" ? " · agent" : null} · {relativeTime(suggestion.createdAt)}
          {suggestion.originalRevisionNumber ? ` · rev ${suggestion.originalRevisionNumber}` : null}
        </p>

        <SuggestionDiff suggestion={suggestion} />

        {suggestion.status === "rejected" && rejectionReason(suggestion) ? (
          <p className="mt-2 rounded bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
            Rejected: {rejectionReason(suggestion)}
          </p>
        ) : null}

        {suggestion.comments.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Discussion ({suggestion.comments.length})
            </p>
            {suggestion.comments.map((comment) => {
              const commentAuthor = resolveReviewAuthor(comment, authorMaps ?? {});
              return (
                <div key={comment.id} className="rounded border border-border bg-background px-2 py-1">
                  <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-medium text-foreground">{commentAuthor.name}</span>
                    <span className="text-muted-foreground">{relativeTime(comment.createdAt)}</span>
                  </div>
                  <MarkdownBody className="text-sm leading-6">{comment.body}</MarkdownBody>
                </div>
              );
            })}
          </div>
        ) : null}

        {canReview ? (
          <div className="mt-2 space-y-2">
            <Textarea
              data-testid={`suggestion-reply-${suggestion.id}`}
              value={reply}
              onChange={(event) => setReply(event.currentTarget.value)}
              placeholder="Reply…"
              rows={2}
              className="min-h-[2.25rem] resize-none text-sm"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
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
              {isPending ? (
                <div className="flex items-center gap-1.5">
                  {rejecting ? null : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-xs"
                            disabled={acceptDisabled}
                            onClick={handleAccept}
                            data-testid={`suggestion-accept-${suggestion.id}`}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            Accept
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {needsRebase ? (
                        <TooltipContent>
                          Document changed since this was suggested. Reload and review again, or
                          rebase the suggestion onto the latest revision.
                        </TooltipContent>
                      ) : null}
                    </Tooltip>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                    onClick={() => setRejecting((value) => !value)}
                    data-testid={`suggestion-reject-toggle-${suggestion.id}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Reject
                  </Button>
                  {onResolve ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={pending != null}
                      onClick={handleResolve}
                      data-testid={`suggestion-resolve-${suggestion.id}`}
                    >
                      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Resolve
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {rejecting ? (
              <div className="space-y-1.5 rounded border border-border bg-muted/40 p-2">
                <label className="text-[11px] font-medium text-muted-foreground" htmlFor={`reject-reason-${suggestion.id}`}>
                  Reason for rejecting (kept for the audit trail)
                </label>
                <Textarea
                  id={`reject-reason-${suggestion.id}`}
                  data-testid={`suggestion-reject-reason-${suggestion.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.currentTarget.value)}
                  placeholder="Why is this being rejected?"
                  rows={2}
                  className="min-h-[2.25rem] resize-none text-sm"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setRejecting(false);
                      setReason("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-xs"
                    disabled={!reason.trim() || pending != null}
                    onClick={handleReject}
                    data-testid={`suggestion-reject-confirm-${suggestion.id}`}
                  >
                    Reject suggestion
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    </TooltipProvider>
  );
}

function rejectionReason(suggestion: DocumentSuggestionWithComments): string | null {
  // The reject reason is persisted as a suggestion comment on the server; the
  // last comment authored at rejection time carries it. Fall back to null.
  if (suggestion.status !== "rejected") return null;
  const last = suggestion.comments[suggestion.comments.length - 1];
  return last?.body ?? null;
}

function SuggestionDiff({ suggestion }: { suggestion: DocumentSuggestionWithComments }) {
  const { kind, selectedText, proposedText, insertionPosition } = suggestion;
  if (kind === "insertion") {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Insert {insertionPosition ? `${insertionPosition} ` : ""}selection
        </p>
        <SuggestionText variant="add">{proposedText ?? ""}</SuggestionText>
        {selectedText ? (
          <p className="truncate text-[11px] text-muted-foreground">near “{selectedText}”</p>
        ) : null}
      </div>
    );
  }
  if (kind === "deletion") {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Delete</p>
        <SuggestionText variant="remove">{selectedText}</SuggestionText>
      </div>
    );
  }
  return (
    <div className="space-y-1 text-sm">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Source</p>
      <SuggestionText variant="remove">{selectedText}</SuggestionText>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Proposed</p>
      <SuggestionText variant="add">{proposedText ?? ""}</SuggestionText>
    </div>
  );
}

function SuggestionText({
  variant,
  children,
}: {
  variant: "add" | "remove";
  children: string;
}) {
  return (
    <p
      data-variant={variant}
      className={cn(
        "whitespace-pre-wrap break-words rounded px-1.5 py-1 text-sm",
        variant === "add"
          ? "bg-[var(--paperclip-doc-suggestion-insert-bg)] text-[var(--paperclip-doc-suggestion-insert-fg)]"
          : "bg-[var(--paperclip-doc-suggestion-delete-bg)] text-[var(--paperclip-doc-suggestion-delete-fg)] line-through",
      )}
    >
      <span aria-hidden="true" className="mr-1 font-bold">
        {variant === "add" ? "+" : "−"}
      </span>
      {children}
    </p>
  );
}
