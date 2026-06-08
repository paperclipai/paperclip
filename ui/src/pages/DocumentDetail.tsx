import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import type {
  Agent,
  CompanyDocument,
  DocumentReviewIndexCounts,
  DocumentSuggestionKind,
  DocumentSuggestionWithComments,
  DocumentType,
} from "@paperclipai/shared";
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Check,
  ClipboardList,
  FileText,
  History,
  Link2,
  ListTodo,
  Lock,
  LockOpen,
  MessageSquare,
  Pencil,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { documentsApi } from "@/api/documents";
import { documentReviewsApi } from "@/api/document-reviews";
import { documentAnnotationsApi } from "@/api/document-annotations";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { cn, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Identity } from "@/components/Identity";
import { InlineEditor } from "@/components/InlineEditor";
import { useOptionalToastActions } from "@/context/ToastContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/lib/router";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import {
  DocumentAnnotationLayer,
  type AnnotationOverlayThread,
  type PendingAnchor,
} from "@/components/DocumentAnnotationLayer";
import { DocumentDiffModal } from "@/components/DocumentDiffModal";
import { DocumentReviewRail } from "@/components/documents/DocumentReviewRail";
import {
  DoneReviewingDialog,
  type DoneReviewingHandoff,
} from "@/components/documents/DoneReviewingDialog";
import { SelectionToolbar, type SuggestionDraftIntent } from "@/components/documents/SelectionToolbar";
import type { RailThread } from "@/components/documents/DocumentThreadCard";

export const DOC_TYPE_ICON: Record<DocumentType, typeof FileText> = {
  plan: ListTodo,
  spec: BookOpen,
  brief: ClipboardList,
  report: BarChart3,
  other: FileText,
};

const DOC_TYPE_LABEL: Record<DocumentType, string> = {
  plan: "Plan",
  spec: "Spec",
  brief: "Brief",
  report: "Report",
  other: "Document",
};

interface IssueBinding {
  issueId: string;
  key: string;
}

/** Resolve the issue + document key the review index is keyed by. */
function resolveIssueBinding(doc: CompanyDocument | undefined): IssueBinding | null {
  if (!doc) return null;
  const link = doc.backlinks.find((b) => b.issueDocumentKey && b.targetType === "issue");
  if (!link?.issueDocumentKey) return null;
  return { issueId: link.targetId, key: link.issueDocumentKey };
}

export function DocumentDetail() {
  const { documentId } = useParams<{ documentId: string }>();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const toast = useOptionalToastActions();
  const queryClient = useQueryClient();

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [commentDraft, setCommentDraft] = useState<{ anchor: PendingAnchor } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [suggestDraft, setSuggestDraft] = useState<{ anchor: PendingAnchor; intent: SuggestionDraftIntent } | null>(null);
  const [proposed, setProposed] = useState("");
  const containerRef = useRef<HTMLElement | null>(null);
  const finishAfterSaveRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  const documentQuery = useQuery({
    queryKey: queryKeys.documents.detail(selectedCompanyId ?? "", documentId ?? ""),
    queryFn: () => documentsApi.get(selectedCompanyId!, documentId!),
    enabled: !!selectedCompanyId && !!documentId,
    retry: (count, error) => !(error instanceof ApiError && [403, 404].includes(error.status)) && count < 2,
  });
  const doc = documentQuery.data;
  const binding = useMemo(() => resolveIssueBinding(doc), [doc]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });

  const reviewIndexQuery = useQuery({
    queryKey: binding ? queryKeys.documents.reviewIndex(binding.issueId, binding.key) : ["documents", "review-index", "none"],
    queryFn: () => documentReviewsApi.reviewIndex(binding!.issueId, binding!.key, { status: "all", includeComments: true }),
    enabled: !!binding,
    retry: (count, error) => !(error instanceof ApiError && [403, 404].includes(error.status)) && count < 2,
  });
  const reviewIndex = reviewIndexQuery.data;

  // The review-index endpoint is gated by the parent issue's authorization
  // boundary, but the document itself is listable via the company-scoped library.
  // A board user who can browse the doc but not its issue gets a 403 here; surface
  // that explicitly instead of falling through to a misleading "no feedback" state.
  const reviewAccessError = useMemo(() => {
    const error = reviewIndexQuery.error;
    if (!(error instanceof ApiError) || error.status !== 403) return null;
    const issueIdentifier = doc?.backlinks.find((b) => b.identifier && b.targetType === "issue")?.identifier;
    return issueIdentifier
      ? `You don't have access to this document's review thread. Ask the owner of ${issueIdentifier} for access.`
      : "You don't have access to this document's review thread. Ask the parent issue's owner for access.";
  }, [reviewIndexQuery.error, doc?.backlinks]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Pick<Agent, "id" | "name">>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);
  const userProfileMap = useMemo(() => buildCompanyUserProfileMap(members?.users), [members?.users]);
  const authorMaps = useMemo(() => ({ agentMap, userProfileMap }), [agentMap, userProfileMap]);

  const currentUserId = session?.user?.id ?? null;
  const isBoard = !!currentUserId;
  const lockedByMe = !!doc?.lockedByUserId && doc.lockedByUserId === currentUserId;
  const lockedByOther = !!(doc?.lockedByAgentId || doc?.lockedByUserId) && !lockedByMe;
  const isArchived = doc?.status === "archived";
  const canReview = isBoard;
  const canEdit = isBoard && !lockedByOther && !isArchived;

  const ownerAgent = doc?.ownerAgentId ? agentMap.get(doc.ownerAgentId) : undefined;
  const lockHolderName = doc?.lockedByAgentId
    ? agentMap.get(doc.lockedByAgentId)?.name ?? "an agent"
    : doc?.lockedByUserId
      ? userProfileMap.get(doc.lockedByUserId)?.label ?? "a board member"
      : null;

  // `from=issue:<identifier>` deep links the breadcrumb back to the source issue
  // so reviewers who opened the doc from an issue land back where they came from.
  const fromParam = searchParams.get("from");
  const fromIssueIdentifier = fromParam?.startsWith("issue:") ? fromParam.slice("issue:".length) : null;
  useEffect(() => {
    const title = doc?.title ?? "Document";
    if (fromIssueIdentifier) {
      setBreadcrumbs([
        { label: "Issues", href: "/issues" },
        { label: fromIssueIdentifier, href: `/issues/${fromIssueIdentifier}` },
        { label: title },
      ]);
    } else {
      setBreadcrumbs([
        { label: "Documents", href: "/documents" },
        { label: title },
      ]);
    }
  }, [setBreadcrumbs, doc?.title, fromIssueIdentifier]);

  const invalidateReview = useCallback(() => {
    if (binding) {
      queryClient.invalidateQueries({ queryKey: queryKeys.documents.reviewIndex(binding.issueId, binding.key) });
    }
  }, [binding, queryClient]);
  const invalidateDoc = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.documents.detail(selectedCompanyId ?? "", documentId ?? ""),
    });
  }, [queryClient, selectedCompanyId, documentId]);

  // --- Mutations -------------------------------------------------------------
  const createComment = useMutation({
    mutationFn: (input: { anchor: PendingAnchor; body: string }) =>
      documentAnnotationsApi.create(binding!.issueId, binding!.key, {
        baseRevisionId: doc!.latestRevisionId!,
        baseRevisionNumber: doc!.latestRevisionNumber,
        selector: input.anchor.selector,
        body: input.body,
      }),
    onSuccess: () => {
      setCommentDraft(null);
      setCommentBody("");
      invalidateReview();
    },
  });

  const createSuggestion = useMutation({
    mutationFn: (input: { anchor: PendingAnchor; intent: SuggestionDraftIntent; proposedText: string | null }) =>
      documentReviewsApi.createSuggestion(binding!.issueId, binding!.key, {
        baseRevisionId: doc!.latestRevisionId!,
        baseRevisionNumber: doc!.latestRevisionNumber,
        kind: input.intent.kind,
        selector: input.anchor.selector,
        proposedText: input.proposedText,
        insertionPosition: input.intent.insertionPosition ?? null,
      }),
    onSuccess: () => {
      setSuggestDraft(null);
      setProposed("");
      invalidateReview();
    },
  });

  const lockMutation = useMutation({
    mutationFn: (lock: boolean) =>
      lock
        ? issuesApi.lockDocument(binding!.issueId, binding!.key)
        : issuesApi.unlockDocument(binding!.issueId, binding!.key),
    onSuccess: invalidateDoc,
  });

  const titleMutation = useMutation({
    mutationFn: (title: string) =>
      documentsApi.updateMetadata(selectedCompanyId!, documentId!, { title: title || null }),
    onSuccess: invalidateDoc,
  });

  const saveMutation = useMutation({
    mutationFn: (body: string) =>
      issuesApi.upsertDocument(binding!.issueId, binding!.key, {
        format: "markdown",
        body,
        baseRevisionId,
      }),
    onSuccess: () => {
      setEditMode(false);
      setConflict(false);
      invalidateDoc();
      invalidateReview();
      if (finishAfterSaveRef.current) {
        finishAfterSaveRef.current = false;
        setHandoffOpen(true);
      }
    },
    onError: (error) => {
      finishAfterSaveRef.current = false;
      if (error instanceof ApiError && error.status === 409) setConflict(true);
    },
  });

  // "Done reviewing" handoff. There is no dedicated review-events endpoint
  // (confirmed against PAP-10523 / the document-feedback contract): the handoff
  // is the issue thread. We record the overall note as a document review thread,
  // optionally post a summary comment on the linked issue (wakes the assignee),
  // and optionally fire a request_confirmation against the latest revision so the
  // owner picks the review back up.
  const reviewHandoff = useMutation({
    mutationFn: async (handoff: DoneReviewingHandoff) => {
      if (!binding || !doc) return;
      const counts = reviewIndex?.counts;
      const summary = buildHandoffComment(doc, counts, handoff.overallComment);

      if (handoff.overallComment) {
        await documentReviewsApi.createReviewThread(binding.issueId, binding.key, {
          body: handoff.overallComment,
        });
      }
      if (handoff.commentOnLinkedIssue) {
        await issuesApi.addComment(binding.issueId, summary);
      }
      if (handoff.wakeOwner && doc.latestRevisionId) {
        await issuesApi.createInteraction(binding.issueId, {
          kind: "request_confirmation",
          idempotencyKey: `confirmation:${binding.issueId}:doc-review:${binding.key}:${doc.latestRevisionId}`,
          title: `Review complete: ${doc.title ?? "document"}`.slice(0, 240),
          summary: summary.slice(0, 1000),
          continuationPolicy: "wake_assignee_on_accept",
          payload: {
            version: 1,
            prompt: "A reviewer finished reviewing this document. Pick the feedback back up when ready.",
            acceptLabel: "Got it",
            rejectLabel: "Dismiss",
            target: {
              type: "issue_document",
              issueId: binding.issueId,
              key: binding.key,
              revisionId: doc.latestRevisionId,
            },
          },
        });
      }
    },
    onSuccess: () => {
      setHandoffOpen(false);
      invalidateReview();
      toast?.pushToast({ title: "Review handed off", tone: "success" });
    },
    onError: () => {
      toast?.pushToast({ title: "Couldn't complete the handoff", tone: "error" });
    },
  });

  // Rail handlers
  const replyThread = useCallback(
    async (thread: RailThread, body: string) => {
      if (!binding) return;
      if (thread.kind === "overall") {
        await documentReviewsApi.addReviewComment(binding.issueId, binding.key, thread.id, { body });
      } else {
        await documentAnnotationsApi.addComment(binding.issueId, binding.key, thread.id, { body });
      }
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  const toggleThreadResolved = useCallback(
    async (thread: RailThread, resolved: boolean) => {
      if (!binding) return;
      const status = resolved ? "resolved" : "open";
      if (thread.kind === "overall") {
        await documentReviewsApi.updateReviewThreadStatus(binding.issueId, binding.key, thread.id, status);
      } else {
        await documentAnnotationsApi.updateStatus(binding.issueId, binding.key, thread.id, status);
      }
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  const addOverallComment = useCallback(
    async (body: string) => {
      if (!binding) return;
      await documentReviewsApi.createReviewThread(binding.issueId, binding.key, { body });
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  const acceptSuggestion = useCallback(
    async (suggestion: DocumentSuggestionWithComments) => {
      if (!binding || !doc?.latestRevisionId) return;
      await documentReviewsApi.acceptSuggestion(binding.issueId, binding.key, suggestion.id, {
        baseRevisionId: doc.latestRevisionId,
      });
      invalidateReview();
      invalidateDoc();
    },
    [binding, doc?.latestRevisionId, invalidateReview, invalidateDoc],
  );

  const rejectSuggestion = useCallback(
    async (suggestion: DocumentSuggestionWithComments, reason: string) => {
      if (!binding) return;
      await documentReviewsApi.rejectSuggestion(binding.issueId, binding.key, suggestion.id, { reason });
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  const replySuggestion = useCallback(
    async (suggestion: DocumentSuggestionWithComments, body: string) => {
      if (!binding) return;
      await documentReviewsApi.addSuggestionComment(binding.issueId, binding.key, suggestion.id, { body });
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  // "Resolve" = handled outside / no longer applies. A first-class `resolved`
  // status (distinct from reject/disagreement) keeps the audit trail honest.
  const resolveSuggestion = useCallback(
    async (suggestion: DocumentSuggestionWithComments) => {
      if (!binding) return;
      await documentReviewsApi.resolveSuggestion(binding.issueId, binding.key, suggestion.id);
      invalidateReview();
    },
    [binding, invalidateReview],
  );

  const startEdit = useCallback(() => {
    if (!doc) return;
    setDraft(doc.body);
    setBaseRevisionId(doc.latestRevisionId);
    setConflict(false);
    setEditMode(true);
  }, [doc]);

  const overlayThreads = useMemo<AnnotationOverlayThread[]>(
    () =>
      (reviewIndex?.annotationThreads ?? []).map((thread) => ({
        id: thread.id,
        selectedText: thread.selectedText,
        status: thread.status,
        anchorState: thread.anchorState,
      })),
    [reviewIndex?.annotationThreads],
  );

  // --- Render guards ---------------------------------------------------------
  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view this document." />;
  }
  if (documentQuery.error instanceof ApiError && [403, 404].includes(documentQuery.error.status)) {
    return (
      <EmptyState
        icon={Lock}
        message="You don't have access to this document."
        action="Back to your documents"
        onAction={() => {
          window.location.href = window.location.pathname.replace(/\/documents\/.*/, "/documents");
        }}
      />
    );
  }
  if (documentQuery.isLoading || !doc) {
    return <DocumentDetailSkeleton />;
  }

  const TypeIcon = DOC_TYPE_ICON[doc.documentType] ?? FileText;
  const staleBase = !editMode && baseRevisionId != null && baseRevisionId !== doc.latestRevisionId;
  const showConflictBanner = conflict || staleBase;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
        {/* Center column */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <DocumentHeader
            doc={doc}
            TypeIcon={TypeIcon}
            ownerName={ownerAgent?.name ?? null}
            ownerAgentId={doc.ownerAgentId}
            canEdit={canEdit}
            canReview={canReview}
            isBoard={isBoard}
            editMode={editMode}
            lockedByMe={lockedByMe}
            lockedByOther={lockedByOther}
            lockHolderName={lockHolderName}
            onEdit={startEdit}
            onSuggestEdit={() => {
              setRailOpen(true);
              toast?.pushToast({
                title: "Select text in the document, then choose Suggest edit",
                tone: "info",
              });
            }}
            onSaveTitle={(title) => titleMutation.mutateAsync(title)}
            onHistory={() => setDiffOpen(true)}
            onToggleLock={() => lockMutation.mutate(!lockedByMe)}
            onCopyLink={() => toast?.pushToast({ title: "Link copied", tone: "success" })}
            lockPending={lockMutation.isPending}
          />

          {showConflictBanner ? (
            <div
              role="alert"
              data-testid="document-conflict-banner"
              className="mx-4 mb-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Someone updated this document while you were editing.</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDiffOpen(true)}>
                  View their changes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    setBaseRevisionId(doc.latestRevisionId);
                    setConflict(false);
                  }}
                >
                  Rebase my draft
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-destructive hover:text-destructive"
                  onClick={() => {
                    setDraft(doc.body);
                    setBaseRevisionId(doc.latestRevisionId);
                    setConflict(false);
                    setEditMode(false);
                  }}
                >
                  Discard mine
                </Button>
              </div>
            </div>
          ) : null}

          <div className="px-4 pb-24 lg:pb-8">
            <div className="mx-auto w-full max-w-[78ch]">
              {editMode ? (
                <div className="space-y-3">
                  <MarkdownEditor value={draft} onChange={setDraft} />
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saveMutation.isPending}
                      onClick={() => {
                        finishAfterSaveRef.current = false;
                        saveMutation.mutate(draft);
                      }}
                      data-testid="save-draft"
                    >
                      Save draft
                    </Button>
                    <Button
                      size="sm"
                      disabled={saveMutation.isPending}
                      onClick={() => {
                        finishAfterSaveRef.current = true;
                        saveMutation.mutate(draft);
                      }}
                      data-testid="save-finish-review"
                    >
                      Save + finish review
                    </Button>
                  </div>
                </div>
              ) : (
                <section
                  ref={(el) => {
                    containerRef.current = el;
                  }}
                  className="relative min-w-0"
                  data-testid="document-detail-body"
                >
                  <div className="relative z-[1]">
                    <MarkdownBody>{doc.body}</MarkdownBody>
                  </div>
                  {doc.latestRevisionId && binding ? (
                    <DocumentAnnotationLayer
                      containerRef={containerRef}
                      markdown={doc.body}
                      threads={overlayThreads}
                      focusedThreadId={null}
                      onThreadFocus={() => setRailOpen(true)}
                      pendingAnchor={null}
                      onPendingAnchorChange={() => {}}
                      onRequestComment={(anchor) => {
                        setCommentDraft({ anchor });
                        setCommentBody("");
                      }}
                      newCommentDisabled={!canReview}
                      newCommentDisabledReason={canReview ? null : "Sign in to leave feedback."}
                      hideResolved
                      renderSelectionToolbar={({ anchor, clear }) => (
                        <SelectionToolbar
                          onComment={() => {
                            setCommentDraft({ anchor });
                            setCommentBody("");
                            clear();
                          }}
                          onSuggest={(intent) => {
                            if (intent.kind === "deletion") {
                              createSuggestion.mutate({ anchor, intent, proposedText: null });
                            } else {
                              setSuggestDraft({ anchor, intent });
                              setProposed("");
                            }
                            clear();
                          }}
                          commentDisabled={!canReview}
                          commentDisabledReason="Sign in to leave feedback."
                          suggestDisabled={!canReview}
                          suggestDisabledReason="Sign in to suggest edits."
                        />
                      )}
                    />
                  ) : null}
                </section>
              )}
            </div>
          </div>
        </div>

        {/* Desktop rail */}
        {!isMobile ? (
          <div className="hidden w-[360px] shrink-0 lg:block">
            <DocumentReviewRail
              reviewIndex={reviewIndex}
              loading={reviewIndexQuery.isLoading}
              accessError={reviewAccessError}
              canReview={canReview}
              canFinishReview={canEdit && !reviewAccessError}
              doneReviewingDisabledReason={reviewAccessError}
              latestRevisionId={doc.latestRevisionId}
              authorMaps={authorMaps}
              onReplyThread={replyThread}
              onToggleThreadResolved={toggleThreadResolved}
              onAddOverallComment={canReview ? addOverallComment : undefined}
              onAcceptSuggestion={acceptSuggestion}
              onRejectSuggestion={rejectSuggestion}
              onResolveSuggestion={resolveSuggestion}
              onReplySuggestion={replySuggestion}
              onViewSuggestionDiff={() => setDiffOpen(true)}
              onDoneReviewing={() => setHandoffOpen(true)}
            />
          </div>
        ) : null}

        {/* Mobile FAB + sheet */}
        {isMobile ? (
          <>
            <button
              type="button"
              data-testid="document-rail-fab"
              onClick={() => setRailOpen(true)}
              // Lift the FAB above the iOS home indicator (§5.8) so it clears the
              // safe-area inset and never occludes the last paragraph.
              className="fixed bottom-[max(env(safe-area-inset-bottom),1rem)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover px-4 py-2 text-sm shadow-lg"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              {(reviewIndex?.counts.openAnchoredThreads ?? 0) + (reviewIndex?.counts.openReviewThreads ?? 0)}
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {reviewIndex?.counts.pendingSuggestions ?? 0}
            </button>
            <DocumentReviewRail
              isMobile
              open={railOpen}
              onOpenChange={setRailOpen}
              reviewIndex={reviewIndex}
              loading={reviewIndexQuery.isLoading}
              accessError={reviewAccessError}
              canReview={canReview}
              canFinishReview={canEdit && !reviewAccessError}
              doneReviewingDisabledReason={reviewAccessError}
              latestRevisionId={doc.latestRevisionId}
              authorMaps={authorMaps}
              onReplyThread={replyThread}
              onToggleThreadResolved={toggleThreadResolved}
              onAddOverallComment={canReview ? addOverallComment : undefined}
              onAcceptSuggestion={acceptSuggestion}
              onRejectSuggestion={rejectSuggestion}
              onResolveSuggestion={resolveSuggestion}
              onReplySuggestion={replySuggestion}
              onViewSuggestionDiff={() => setDiffOpen(true)}
              onDoneReviewing={() => {
                setRailOpen(false);
                setHandoffOpen(true);
              }}
            />
          </>
        ) : null}
      </div>

      {/* Comment composer */}
      <Dialog open={!!commentDraft} onOpenChange={(open) => !open && setCommentDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Comment on selection</DialogTitle>
          </DialogHeader>
          {commentDraft ? (
            <p className="mb-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              “{commentDraft.anchor.selectedText}”
            </p>
          ) : null}
          <Textarea
            data-testid="comment-composer"
            value={commentBody}
            onChange={(e) => setCommentBody(e.currentTarget.value)}
            placeholder="Add your comment…"
            rows={4}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCommentDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!commentBody.trim() || createComment.isPending}
              onClick={() => commentDraft && createComment.mutate({ anchor: commentDraft.anchor, body: commentBody.trim() })}
            >
              Comment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suggestion composer */}
      <Dialog open={!!suggestDraft} onOpenChange={(open) => !open && setSuggestDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{suggestionDialogTitle(suggestDraft?.intent.kind)}</DialogTitle>
          </DialogHeader>
          {suggestDraft ? (
            <p className="mb-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              “{suggestDraft.anchor.selectedText}”
            </p>
          ) : null}
          <Textarea
            data-testid="suggestion-composer"
            value={proposed}
            onChange={(e) => setProposed(e.currentTarget.value)}
            placeholder="Proposed text…"
            rows={4}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuggestDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!proposed.trim() || createSuggestion.isPending}
              onClick={() =>
                suggestDraft &&
                createSuggestion.mutate({ anchor: suggestDraft.anchor, intent: suggestDraft.intent, proposedText: proposed.trim() })
              }
            >
              Suggest edit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DoneReviewingDialog
        open={handoffOpen}
        onOpenChange={setHandoffOpen}
        counts={reviewIndex?.counts}
        accessError={reviewAccessError}
        issueIdentifier={doc.backlinks.find((b) => b.identifier && b.targetType === "issue")?.identifier ?? null}
        ownerName={ownerAgent?.name ?? null}
        canWakeOwner={!!doc.ownerAgentId && !!doc.latestRevisionId}
        submitting={reviewHandoff.isPending}
        onSubmit={(handoff) => reviewHandoff.mutate(handoff)}
      />

      {binding ? (
        <DocumentDiffModal
          issueId={binding.issueId}
          documentKey={binding.key}
          latestRevisionNumber={doc.latestRevisionNumber}
          open={diffOpen}
          onOpenChange={setDiffOpen}
        />
      ) : null}
    </TooltipProvider>
  );
}

function suggestionDialogTitle(kind?: DocumentSuggestionKind): string {
  if (kind === "insertion") return "Insert text";
  if (kind === "deletion") return "Delete selection";
  return "Replace selection";
}

/** Markdown summary posted to the linked issue / interaction on review completion. */
function buildHandoffComment(
  doc: CompanyDocument,
  counts: DocumentReviewIndexCounts | undefined,
  overallComment: string,
): string {
  const openComments = (counts?.openAnchoredThreads ?? 0) + (counts?.openReviewThreads ?? 0);
  const lines = [
    `## Review complete: ${doc.title ?? "document"}`,
    "",
    `Reviewed **rev ${doc.latestRevisionNumber}**.`,
    "",
    `- Open comments: ${openComments}`,
    `- Pending suggestions: ${counts?.pendingSuggestions ?? 0}`,
    `- Stale anchors: ${counts?.staleAnchors ?? 0}`,
    `- Orphaned anchors: ${counts?.orphanedAnchors ?? 0}`,
  ];
  if (overallComment) {
    lines.push("", `**Overall:** ${overallComment}`);
  }
  return lines.join("\n");
}

export interface DocumentHeaderProps {
  doc: CompanyDocument;
  TypeIcon: typeof FileText;
  ownerName: string | null;
  ownerAgentId: string | null;
  canEdit: boolean;
  canReview: boolean;
  isBoard: boolean;
  editMode: boolean;
  lockedByMe: boolean;
  lockedByOther: boolean;
  lockHolderName: string | null;
  onEdit: () => void;
  onSuggestEdit: () => void;
  onSaveTitle: (title: string) => Promise<unknown>;
  onHistory: () => void;
  onToggleLock: () => void;
  onCopyLink: () => void;
  lockPending: boolean;
}

export function DocumentHeader({
  doc,
  TypeIcon,
  ownerName,
  ownerAgentId,
  canEdit,
  canReview,
  isBoard,
  editMode,
  lockedByMe,
  lockedByOther,
  lockHolderName,
  onEdit,
  onSuggestEdit,
  onSaveTitle,
  onHistory,
  onToggleLock,
  onCopyLink,
  lockPending,
}: DocumentHeaderProps) {
  const [copied, setCopied] = useState(false);
  const backlinks = doc.backlinks.filter((b) => b.identifier);
  const shownBacklinks = backlinks.slice(0, 5);
  const extraBacklinks = backlinks.length - shownBacklinks.length;

  const copyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href).catch(() => {});
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
    onCopyLink();
  };

  return (
    <header className="px-4 pt-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {canEdit ? (
          <InlineEditor
            value={doc.title ?? ""}
            onSave={(next) => onSaveTitle(next.trim())}
            as="h1"
            nullable
            placeholder="Untitled document"
            className="text-xl font-bold text-foreground"
          />
        ) : (
          <h1 className="text-xl font-bold text-foreground">{doc.title ?? "Untitled document"}</h1>
        )}
        <StatusBadge status={doc.status} />
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <TypeIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {DOC_TYPE_LABEL[doc.documentType]}
        </span>
        {ownerName ? (
          ownerAgentId ? (
            <Link
              to={`/documents?owner=${ownerAgentId}`}
              className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground"
              title={`Filter documents owned by ${ownerName}`}
            >
              <Identity name={ownerName} size="sm" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Identity name={ownerName} size="sm" />
            </span>
          )
        ) : null}
        {!isBoard ? (
          <Badge className="border-transparent bg-muted px-1.5 py-0 text-[10px] text-muted-foreground" data-testid="readonly-badge">
            Read-only
          </Badge>
        ) : null}
        {lockedByOther ? (
          <Badge
            data-testid="locked-by-other"
            className="gap-1 border-transparent bg-amber-100 px-1.5 py-0 text-[10px] text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
          >
            <Lock className="h-3 w-3" aria-hidden="true" />
            Locked by {lockHolderName}
          </Badge>
        ) : null}
        {lockedByMe ? (
          <Badge className="gap-1 border-transparent bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Locked by you
          </Badge>
        ) : null}
      </div>

      {/* Action row */}
      {!editMode ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button size="sm" variant="outline" className="h-8" disabled={!canEdit} onClick={onEdit} data-testid="action-edit">
                  <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </Button>
              </span>
            </TooltipTrigger>
            {!canEdit ? (
              <TooltipContent>
                {lockedByOther ? `Locked by ${lockHolderName}` : "You don't have edit access."}
              </TooltipContent>
            ) : null}
          </Tooltip>
          {canReview ? (
            <Button size="sm" variant="ghost" className="h-8" onClick={onSuggestEdit} data-testid="action-suggest-edit">
              <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Suggest edit
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="h-8" onClick={onHistory} data-testid="action-history">
            <History className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            History
          </Button>
          {isBoard ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={lockedByOther || lockPending}
              onClick={onToggleLock}
              data-testid="action-lock"
            >
              {lockedByMe ? (
                <>
                  <LockOpen className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Unlock
                </>
              ) : (
                <>
                  <Lock className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Lock
                </>
              )}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="h-8" onClick={copyLink} data-testid="action-copy-link">
            {copied ? (
              <Check className="mr-1 h-3.5 w-3.5 text-green-600 dark:text-green-400" aria-hidden="true" />
            ) : (
              <Link2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" className="h-8 w-8" aria-label="More actions" data-testid="action-overflow">
                <span aria-hidden="true">⋯</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled>Archive</DropdownMenuItem>
              <DropdownMenuItem disabled>Manage links…</DropdownMenuItem>
              <DropdownMenuItem disabled>Export</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {/* Backlinks */}
      {shownBacklinks.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Backlinks:</span>
          {shownBacklinks.map((link) => (
            <Link key={link.id} to={`/issues/${link.identifier}`}>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">
                {link.identifier}
              </Badge>
            </Link>
          ))}
          {extraBacklinks > 0 ? (
            <span className="text-[11px] text-muted-foreground">+{extraBacklinks} more</span>
          ) : null}
        </div>
      ) : null}

      {/* Meta row */}
      <div className="mb-3 flex items-center gap-2 border-b border-border pb-3 text-[11px] text-muted-foreground">
        <Badge asChild variant="outline" className="cursor-pointer px-1.5 py-0 font-mono hover:bg-accent/50">
          <button type="button" onClick={onHistory} data-testid="meta-rev">
            Rev {doc.latestRevisionNumber}
          </button>
        </Badge>
        <span>updated {relativeTime(doc.updatedAt)}</span>
        {/* Autosave indicator slot (§5.2) — wired when autosave lands. */}
        <span data-testid="autosave-slot" className="ml-auto empty:hidden" aria-live="polite" />
      </div>
    </header>
  );
}

function DocumentDetailSkeleton() {
  return (
    <div className="w-full px-4 py-4" data-testid="document-detail-skeleton">
      <div className="mb-3 h-7 w-1/2 animate-pulse rounded bg-muted" />
      <div className="mb-2 h-8 w-72 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-4 w-full animate-pulse rounded bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
