import { useMemo, useState } from "react";
import type {
  DocumentReviewIndex,
  DocumentSuggestionWithComments,
} from "@paperclipai/shared";
import { CheckCircle2, ChevronDown, ChevronRight, Lock, MessageSquarePlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, isApplePlatform } from "@/lib/utils";
import type { ReviewAuthorMaps } from "@/lib/document-review-authors";
import { DocumentThreadCard, type RailThread } from "./DocumentThreadCard";
import { SuggestionCard } from "./SuggestionCard";

type ReviewFilter = "open" | "resolved" | "stale" | "orphaned";

const FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "stale", label: "Stale" },
  { id: "orphaned", label: "Orphaned" },
];

function threadBucket(thread: RailThread): ReviewFilter {
  if (thread.anchorState === "orphaned") return "orphaned";
  if (thread.anchorState === "stale") return "stale";
  if (thread.status === "resolved") return "resolved";
  return "open";
}

function suggestionBucket(suggestion: DocumentSuggestionWithComments): ReviewFilter {
  if (suggestion.anchorState === "orphaned") return "orphaned";
  if (suggestion.anchorState === "stale") return "stale";
  if (suggestion.status !== "pending") return "resolved";
  return "open";
}

export interface DocumentReviewRailProps {
  reviewIndex?: DocumentReviewIndex;
  loading?: boolean;
  /**
   * When the viewer can browse the document but can't read its review thread
   * (the review-index endpoint is gated by parent-issue access), surface this
   * message instead of a misleading "no feedback" empty state.
   */
  accessError?: string | null;
  /** Viewer can reply/resolve/accept/reject. */
  canReview: boolean;
  /** Viewer has edit rights (gates the Done reviewing CTA). */
  canFinishReview?: boolean;
  doneReviewingDisabledReason?: string | null;
  latestRevisionId: string | null;
  authorMaps?: ReviewAuthorMaps;
  focusedThreadId?: string | null;
  onFocusThread?: (threadId: string) => void;
  onReplyThread: (thread: RailThread, body: string) => Promise<void> | void;
  onToggleThreadResolved: (thread: RailThread, resolved: boolean) => Promise<void> | void;
  onAddOverallComment?: (body: string) => Promise<void> | void;
  onAcceptSuggestion: (suggestion: DocumentSuggestionWithComments) => Promise<void> | void;
  onRejectSuggestion: (suggestion: DocumentSuggestionWithComments, reason: string) => Promise<void> | void;
  onResolveSuggestion?: (suggestion: DocumentSuggestionWithComments) => Promise<void> | void;
  onReplySuggestion: (suggestion: DocumentSuggestionWithComments, body: string) => Promise<void> | void;
  onViewSuggestionDiff?: (suggestion: DocumentSuggestionWithComments) => void;
  onDoneReviewing?: () => void;
  /** Which tab to open first (e.g. when a deep link targets a suggestion). */
  initialTab?: "comments" | "suggestions";
  /** Mobile: render inside a bottom Sheet. */
  isMobile?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function DocumentReviewRail(props: DocumentReviewRailProps) {
  if (props.isMobile) {
    return (
      <Sheet open={props.open ?? false} onOpenChange={props.onOpenChange ?? (() => {})}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="z-[60] flex max-h-[88vh] flex-col rounded-t-lg border-t border-border bg-popover p-0 text-popover-foreground shadow-2xl"
        >
          <SheetTitle className="sr-only">Document review</SheetTitle>
          <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          <ReviewRailBody {...props} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      role="complementary"
      aria-label="Document review"
      data-testid="document-review-rail"
      className={cn("flex h-full w-full flex-col overflow-hidden border-l border-border bg-card", props.className)}
    >
      <ReviewRailBody {...props} />
    </aside>
  );
}

function ReviewRailBody({
  reviewIndex,
  loading,
  accessError,
  canReview,
  canFinishReview,
  doneReviewingDisabledReason,
  latestRevisionId,
  authorMaps,
  focusedThreadId,
  onFocusThread,
  onReplyThread,
  onToggleThreadResolved,
  onAddOverallComment,
  onAcceptSuggestion,
  onRejectSuggestion,
  onResolveSuggestion,
  onReplySuggestion,
  onViewSuggestionDiff,
  onDoneReviewing,
  initialTab = "comments",
}: DocumentReviewRailProps) {
  const [tab, setTab] = useState<"comments" | "suggestions">(initialTab);
  const [filters, setFilters] = useState<Set<ReviewFilter>>(new Set(["open"]));
  const [composeOverall, setComposeOverall] = useState(false);
  const [overall, setOverall] = useState("");
  const [overallPending, setOverallPending] = useState(false);

  const counts = reviewIndex?.counts;
  const commentCount = (counts?.openAnchoredThreads ?? 0) + (counts?.openReviewThreads ?? 0);
  const suggestionCount = counts?.pendingSuggestions ?? 0;

  const overallThreads = useMemo<RailThread[]>(
    () =>
      (reviewIndex?.reviewThreads ?? []).map((thread) => ({
        id: thread.id,
        kind: "overall" as const,
        status: thread.status,
        anchorState: null,
        selectedText: null,
        comments: thread.comments,
      })),
    [reviewIndex?.reviewThreads],
  );

  const anchoredThreads = useMemo<RailThread[]>(
    () =>
      (reviewIndex?.annotationThreads ?? []).map((thread) => ({
        id: thread.id,
        kind: "anchored" as const,
        status: thread.status,
        anchorState: thread.anchorState,
        selectedText: thread.selectedText,
        comments: thread.comments,
      })),
    [reviewIndex?.annotationThreads],
  );

  const activeFilters = filters.size === 0 ? new Set<ReviewFilter>(FILTERS.map((f) => f.id)) : filters;

  const threadMatches = (thread: RailThread): boolean => activeFilters.has(threadBucket(thread));

  const suggestionMatches = (suggestion: DocumentSuggestionWithComments): boolean =>
    activeFilters.has(suggestionBucket(suggestion));

  // Per-filter counts for the active tab so empty buckets read as empty and the
  // stale/orphaned rows become discoverable rather than guess-and-click.
  const filterCounts = useMemo(() => {
    const counts: Record<ReviewFilter, number> = { open: 0, resolved: 0, stale: 0, orphaned: 0 };
    if (tab === "comments") {
      for (const thread of [...overallThreads, ...anchoredThreads]) counts[threadBucket(thread)] += 1;
    } else {
      for (const s of reviewIndex?.suggestions ?? []) counts[suggestionBucket(s)] += 1;
    }
    return counts;
  }, [tab, overallThreads, anchoredThreads, reviewIndex?.suggestions]);

  const visibleOverall = overallThreads.filter(threadMatches);
  const visibleAnchored = anchoredThreads.filter(threadMatches);
  const orphanedThreads = visibleAnchored.filter((t) => t.anchorState === "orphaned");
  const nonOrphanThreads = visibleAnchored.filter((t) => t.anchorState !== "orphaned");

  const suggestions = reviewIndex?.suggestions ?? [];
  const visibleSuggestions = suggestions.filter(suggestionMatches);
  const orphanedSuggestions = visibleSuggestions.filter((s) => s.anchorState === "orphaned");
  const nonOrphanSuggestions = visibleSuggestions.filter((s) => s.anchorState !== "orphaned");

  const toggleFilter = (id: ReviewFilter) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddOverall = async () => {
    const trimmed = overall.trim();
    if (!trimmed || !onAddOverallComment) return;
    setOverallPending(true);
    try {
      await onAddOverallComment(trimmed);
      setOverall("");
      setComposeOverall(false);
    } finally {
      setOverallPending(false);
    }
  };

  if (accessError) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-center" data-testid="rail-access-error">
        <Lock className="mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">Review thread unavailable</p>
        <p className="mt-1 max-w-[28ch] text-xs text-muted-foreground">{accessError}</p>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-2 pt-2">
            <TabsList variant="line" className="w-full">
              <TabsTrigger value="comments" className="flex-1" data-testid="rail-tab-comments">
                Comments ({commentCount})
              </TabsTrigger>
              <TabsTrigger value="suggestions" className="flex-1" data-testid="rail-tab-suggestions">
                Suggestions ({suggestionCount})
              </TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-1 py-2" role="group" aria-label="Review filters">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  data-testid={`rail-filter-${filter.id}`}
                  data-active={filters.has(filter.id) || undefined}
                  onClick={() => toggleFilter(filter.id)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                    filters.has(filter.id)
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  {filter.label}
                  {filterCounts[filter.id] > 0 ? (
                    <span className="ml-1 tabular-nums opacity-70">{filterCounts[filter.id]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <RailSkeleton />
            ) : (
              <>
                <TabsContent value="comments" className="mt-0 space-y-2">
                  {onAddOverallComment ? (
                    composeOverall ? (
                      <div className="space-y-2 rounded-md border border-border bg-card p-2">
                        <Textarea
                          data-testid="rail-overall-composer"
                          value={overall}
                          onChange={(event) => setOverall(event.currentTarget.value)}
                          placeholder="Leave overall feedback on the whole document…"
                          rows={3}
                          className="resize-none text-sm"
                        />
                        <div className="flex items-center justify-end gap-1.5">
                          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setComposeOverall(false)}>
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={!overall.trim() || overallPending}
                            onClick={handleAddOverall}
                          >
                            Comment
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 w-full justify-start gap-1.5 text-xs"
                        onClick={() => setComposeOverall(true)}
                        data-testid="rail-add-overall"
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                        Add overall comment
                      </Button>
                    )
                  ) : null}

                  {visibleOverall.map((thread) => (
                    <DocumentThreadCard
                      key={thread.id}
                      thread={thread}
                      canReview={canReview}
                      authorMaps={authorMaps}
                      focused={focusedThreadId === thread.id}
                      onFocus={onFocusThread}
                      onReply={onReplyThread}
                      onToggleResolved={onToggleThreadResolved}
                    />
                  ))}

                  {orphanedThreads.length > 0 ? (
                    <OrphanGroup count={orphanedThreads.length}>
                      {orphanedThreads.map((thread) => (
                        <DocumentThreadCard
                          key={thread.id}
                          thread={thread}
                          canReview={canReview}
                          authorMaps={authorMaps}
                          focused={focusedThreadId === thread.id}
                          onFocus={onFocusThread}
                          onReply={onReplyThread}
                          onToggleResolved={onToggleThreadResolved}
                        />
                      ))}
                    </OrphanGroup>
                  ) : null}

                  {nonOrphanThreads.map((thread) => (
                    <DocumentThreadCard
                      key={thread.id}
                      thread={thread}
                      canReview={canReview}
                      authorMaps={authorMaps}
                      focused={focusedThreadId === thread.id}
                      onFocus={onFocusThread}
                      onReply={onReplyThread}
                      onToggleResolved={onToggleThreadResolved}
                    />
                  ))}

                  {visibleOverall.length === 0 && visibleAnchored.length === 0 ? (
                    <RailEmpty message="No feedback yet. Highlight text to comment or suggest an edit." />
                  ) : null}
                </TabsContent>

                <TabsContent value="suggestions" className="mt-0 space-y-2">
                  {orphanedSuggestions.length > 0 ? (
                    <OrphanGroup count={orphanedSuggestions.length}>
                      {orphanedSuggestions.map((suggestion) => (
                        <SuggestionCard
                          key={suggestion.id}
                          suggestion={suggestion}
                          latestRevisionId={latestRevisionId}
                          canReview={canReview}
                          authorMaps={authorMaps}
                          onAccept={onAcceptSuggestion}
                          onReject={onRejectSuggestion}
                          onResolve={onResolveSuggestion}
                          onReply={onReplySuggestion}
                          onViewDiff={onViewSuggestionDiff}
                        />
                      ))}
                    </OrphanGroup>
                  ) : null}

                  {nonOrphanSuggestions.map((suggestion) => (
                    <SuggestionCard
                      key={suggestion.id}
                      suggestion={suggestion}
                      latestRevisionId={latestRevisionId}
                      canReview={canReview}
                      authorMaps={authorMaps}
                      onAccept={onAcceptSuggestion}
                      onReject={onRejectSuggestion}
                      onResolve={onResolveSuggestion}
                      onReply={onReplySuggestion}
                      onViewDiff={onViewSuggestionDiff}
                    />
                  ))}

                  {visibleSuggestions.length === 0 ? (
                    <RailEmpty message="No suggested edits. Select text and choose “Suggest edit”." />
                  ) : null}
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>

        <div className="border-t border-border p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              {/*
                Use aria-disabled (not the `disabled` attribute) so the button stays
                in the tab order and remains the tooltip trigger: keyboard and screen-reader
                users can focus it to learn *why* it's disabled, instead of hitting a dead
                control. onClick is guarded so the action can't fire while disabled.
              */}
              <Button
                type="button"
                className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                size="sm"
                aria-disabled={!canFinishReview || undefined}
                onClick={(event) => {
                  if (!canFinishReview) {
                    event.preventDefault();
                    return;
                  }
                  onDoneReviewing?.();
                }}
                data-testid="rail-done-reviewing"
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Done reviewing
              </Button>
            </TooltipTrigger>
            {!canFinishReview ? (
              <TooltipContent>
                {doneReviewingDisabledReason ?? "Read-only documents can't be marked reviewed"}
              </TooltipContent>
            ) : null}
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

function OrphanGroup({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-1.5" data-testid="rail-orphan-group">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-1 py-0.5 text-[11px] font-medium text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>Orphaned feedback ({count})</span>
      </button>
      {open ? <div className="mt-1.5 space-y-2">{children}</div> : null}
    </div>
  );
}

function RailEmpty({ message }: { message: string }) {
  // Platform-aware hint: macOS/iOS reviewers see ⌘⇧M, Windows/Linux see Ctrl+Shift+M.
  const hotkey = isApplePlatform() ? "⌘⇧M" : "Ctrl+Shift+M";
  return (
    <div className="px-2 py-8 text-center text-xs text-muted-foreground" data-testid="rail-empty">
      <p>{message}</p>
      <p className="mt-1 text-[11px] opacity-70">{hotkey} to comment from a selection</p>
    </div>
  );
}

function RailSkeleton() {
  return (
    <div className="space-y-2" data-testid="rail-skeleton">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-20 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </div>
  );
}
