import { MessageSquare, PencilLine } from "lucide-react";
import type { DocumentFeedbackCounts as DocumentFeedbackCountsData } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

export function openCommentCount(counts: DocumentFeedbackCountsData): number {
  return counts.openComments + counts.openReviewThreads;
}

export function pendingSuggestionCount(counts: DocumentFeedbackCountsData): number {
  return counts.pendingSuggestions;
}

export function hasOpenDocumentFeedback(counts: DocumentFeedbackCountsData | null | undefined): boolean {
  if (!counts) return false;
  return openCommentCount(counts) > 0 || pendingSuggestionCount(counts) > 0;
}

/**
 * Compact `💬 N · ✎ M` feedback summary for a document — open comments and pending
 * suggestions. Shared between the inline issue document card and the Documents tab so
 * the same counts read identically everywhere. Renders nothing when there is no feedback.
 */
export function DocumentFeedbackCounts({
  counts,
  className,
}: {
  counts: DocumentFeedbackCountsData | null | undefined;
  className?: string;
}) {
  if (!counts) return null;
  const comments = openCommentCount(counts);
  const suggestions = pendingSuggestionCount(counts);
  if (comments === 0 && suggestions === 0) return null;

  return (
    <span
      className={cn("inline-flex items-center gap-2 text-[11px] text-muted-foreground", className)}
      data-testid="document-feedback-counts"
    >
      {comments > 0 ? (
        <span className="inline-flex items-center gap-0.5" title={`${comments} open comment(s)`}>
          <MessageSquare className="h-3 w-3" aria-hidden="true" />
          <span className="tabular-nums">{comments}</span>
        </span>
      ) : null}
      {suggestions > 0 ? (
        <span className="inline-flex items-center gap-0.5" title={`${suggestions} pending suggestion(s)`}>
          <PencilLine className="h-3 w-3" aria-hidden="true" />
          <span className="tabular-nums">{suggestions}</span>
        </span>
      ) : null}
    </span>
  );
}
