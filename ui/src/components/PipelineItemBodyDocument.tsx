import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PIPELINE_CASE_BODY_DOCUMENT_KEY,
  type Agent,
  type Issue,
  type PipelineCaseDocumentPayload,
} from "@paperclipai/shared";
import { FilePenLine, FileText, Loader2 } from "lucide-react";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { pipelinesApi } from "../api/pipelines";
import type { CompanyUserProfile } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { DocumentAnnotationLayer, type PendingAnchor } from "./DocumentAnnotationLayer";
import { DocumentFrameHeader } from "./DocumentFrameHeader";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "./IssueDocumentAnnotations";
import { EmptyState } from "./EmptyState";
import { FoldCurtain } from "./FoldCurtain";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MentionOption } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";

/** Case-level body document key (PUT /cases/:id/documents/body). */
const BODY_DOCUMENT_KEY = "body";

/** Local view of the shared case document payload `document` field. */
type CaseBodyDocument = PipelineCaseDocumentPayload["document"] & {
  latestBody?: string | null;
  updatedAt?: string | Date | null;
  updatedByAgentId?: string | null;
  updatedByUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export interface PipelineItemBodyDocumentProps {
  caseId: string;
  /** Legacy `case.summary` shown read-only until the first edit migrates it. */
  legacySummary: string | null;
  /** True when the item still has legacy long fields rendered elsewhere. */
  hasLegacyLongFields: boolean;
  /** Active conversation issue the body document is/should be anchored to. */
  conversationIssueId: string | null;
  conversationIssue: Issue | null;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  locationHash: string;
  /** Create (or reuse) the conversation issue. Returns the issue so we can link the body. */
  onStartConversation: () => Promise<Issue | null>;
  /** Invalidate parent-owned queries (case detail, events, conversation) after a change. */
  onAfterChange?: () => void | Promise<void>;
}

export function PipelineItemBodyDocument({
  caseId,
  legacySummary,
  hasLegacyLongFields,
  conversationIssueId,
  conversationIssue,
  agentMap,
  userProfileMap,
  mentions,
  imageUploadHandler,
  locationHash,
  onStartConversation,
  onAfterChange,
}: PipelineItemBodyDocumentProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [folded, setFolded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [revisionMenuOpen, setRevisionMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<PendingAnchor | null>(null);
  const [pendingStartAnchor, setPendingStartAnchor] = useState<PendingAnchor | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const caseDocumentQuery = useQuery({
    queryKey: queryKeys.pipelines.caseDocument(caseId, BODY_DOCUMENT_KEY),
    queryFn: async () => {
      try {
        return await pipelinesApi.getCaseDocument(caseId, BODY_DOCUMENT_KEY);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    staleTime: 15_000,
  });

  const payload = caseDocumentQuery.data ?? null;
  const doc = (payload?.document ?? null) as CaseBodyDocument | null;
  const hasDocument = Boolean(doc && doc.latestRevisionId);
  const latestBody = doc?.latestBody ?? payload?.revision?.body ?? "";

  // The body document is mirrored onto the conversation issue under the system key once
  // it is saved while a conversation is active. Annotations bind to that issue document.
  const conversationDocumentsQuery = useQuery({
    queryKey: conversationIssueId
      ? queryKeys.issues.documents(conversationIssueId)
      : ["pipeline-item-body", caseId, "no-conversation-documents"],
    queryFn: () => issuesApi.listDocuments(conversationIssueId!, { includeSystem: true }),
    enabled: Boolean(conversationIssueId),
    staleTime: 15_000,
  });
  const bodyIssueDocument = useMemo(
    () => conversationDocumentsQuery.data?.find((document) => document.key === PIPELINE_CASE_BODY_DOCUMENT_KEY) ?? null,
    [conversationDocumentsQuery.data],
  );
  const annotationsLinked = Boolean(conversationIssueId && bodyIssueDocument?.latestRevisionId);

  const revisionsQuery = useQuery({
    queryKey: queryKeys.pipelines.caseDocumentRevisions(caseId, BODY_DOCUMENT_KEY),
    queryFn: () => pipelinesApi.listCaseDocumentRevisions(caseId, BODY_DOCUMENT_KEY),
    enabled: revisionMenuOpen && hasDocument,
    staleTime: 10_000,
  });
  const revisions = revisionsQuery.data ?? [];
  const selectedHistoricalRevision = selectedRevisionId
    ? revisions.find((revision) => revision.id === selectedRevisionId) ?? null
    : null;
  const isHistoricalPreview = Boolean(selectedHistoricalRevision);

  const displayedBody = isHistoricalPreview
    ? selectedHistoricalRevision!.body
    : editing
      ? draftBody
      : latestBody;
  const displayedRevisionNumber = selectedHistoricalRevision?.revisionNumber ?? doc?.latestRevisionNumber ?? 1;

  const invalidateAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDocument(caseId, BODY_DOCUMENT_KEY) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDocumentRevisions(caseId, BODY_DOCUMENT_KEY) }),
      conversationIssueId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(conversationIssueId) })
        : Promise.resolve(),
      conversationIssueId
        ? queryClient.invalidateQueries({
            queryKey: queryKeys.issues.documentAnnotations(conversationIssueId, PIPELINE_CASE_BODY_DOCUMENT_KEY, "all"),
          })
        : Promise.resolve(),
    ]);
    await onAfterChange?.();
  }, [caseId, conversationIssueId, onAfterChange, queryClient]);

  const saveMutation = useMutation({
    mutationFn: (input: { body: string; baseRevisionId: string | null; changeSummary?: string | null }) =>
      pipelinesApi.upsertCaseDocument(caseId, BODY_DOCUMENT_KEY, {
        body: input.body,
        baseRevisionId: input.baseRevisionId,
        changeSummary: input.changeSummary ?? null,
      }),
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => pipelinesApi.restoreCaseDocumentRevision(caseId, BODY_DOCUMENT_KEY, revisionId),
    onSuccess: async () => {
      setSelectedRevisionId(null);
      await invalidateAll();
      pushToast({ title: "Revision restored", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not restore the revision", tone: "error" }),
  });

  const beginEdit = useCallback(() => {
    setSelectedRevisionId(null);
    setDraftBody(latestBody || legacySummary || "");
    setEditing(true);
  }, [latestBody, legacySummary]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraftBody("");
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await saveMutation.mutateAsync({
        body: draftBody,
        baseRevisionId: doc?.latestRevisionId ?? null,
      });
      setEditing(false);
      setDraftBody("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await caseDocumentQuery.refetch();
        pushToast({
          title: "Body changed elsewhere",
          body: "This item body was updated by someone else. Reloaded the latest — re-apply your edit.",
          tone: "error",
        });
        return;
      }
      pushToast({ title: "Could not save the body", tone: "error" });
    }
  }, [caseDocumentQuery, doc?.latestRevisionId, draftBody, pushToast, saveMutation]);

  // Selection → comment when the body is not yet anchored to a conversation. Snapshot the
  // anchor, ensure a conversation exists, mirror the body onto it, then hand the anchor to
  // IssueDocumentAnnotations which re-opens the composer once the link lands.
  const handleStartConversationFromAnchor = useCallback(
    async (anchor: PendingAnchor) => {
      setPendingStartAnchor(anchor);
      setSelectionAnchor(null);
      try {
        if (!conversationIssueId) {
          const issue = await onStartConversation();
          if (!issue) {
            setPendingStartAnchor(null);
            return;
          }
        }
        // Re-save the unchanged body so the server links it onto the conversation issue.
        if (doc?.latestRevisionId) {
          await saveMutation.mutateAsync({
            body: latestBody,
            baseRevisionId: doc.latestRevisionId,
            changeSummary: "Linked body to conversation for comments",
          });
        }
        setPanelOpen(true);
      } catch {
        setPendingStartAnchor(null);
        pushToast({ title: "Could not start the conversation", tone: "error" });
      }
    },
    [conversationIssueId, doc?.latestRevisionId, latestBody, onStartConversation, pushToast, saveMutation],
  );

  const bodyContentClassName = "paperclip-edit-in-place-content min-h-[220px] text-[15px] leading-7";

  const renderReadOnlyBody = (body: string) => (
    <FoldCurtain className="max-w-3xl">
      <MarkdownBody className={bodyContentClassName} softBreaks={false}>{body}</MarkdownBody>
    </FoldCurtain>
  );

  // ── Body content (edit / preview / read) ──────────────────────────────────────────────
  let bodyContent: React.ReactNode;
  if (editing) {
    bodyContent = (
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelEdit();
          }
        }}
      >
        <div className="rounded-md border border-border bg-background">
          <MarkdownEditor
            value={draftBody}
            onChange={setDraftBody}
            placeholder="Write the item body in Markdown…"
            bordered={false}
            className="min-h-[220px] bg-transparent"
            contentClassName={bodyContentClassName}
            mentions={mentions}
            imageUploadHandler={imageUploadHandler}
            onSubmit={() => void handleSave()}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            Saving creates rev {(doc?.latestRevisionNumber ?? 0) + 1} · ⌘↵ to save · Esc to cancel
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (isHistoricalPreview && selectedHistoricalRevision) {
    bodyContent = (
      <div className="space-y-3">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-200">
                Viewing revision {selectedHistoricalRevision.revisionNumber}
              </p>
              <p className="text-xs text-muted-foreground">
                Historical preview. New comments are disabled while previewing a historical revision. Restoring it
                creates a new latest revision and keeps history append-only.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedRevisionId(null)}>
                Return to latest
              </Button>
              <Button
                size="sm"
                onClick={() => restoreMutation.mutate(selectedHistoricalRevision.id)}
                disabled={restoreMutation.isPending}
              >
                {restoreMutation.isPending ? "Restoring…" : "Restore this revision"}
              </Button>
            </div>
          </div>
        </div>
        {renderReadOnlyBody(displayedBody)}
      </div>
    );
  } else if (!hasDocument && legacySummary) {
    // Legacy fallback (B): read-only summary; first Edit→Save migrates it to a document.
    bodyContent = renderReadOnlyBody(legacySummary);
  } else if (!hasDocument) {
    // Truly empty (A).
    bodyContent = (
      <EmptyState icon={FileText} message="No body yet. Capture the item's details here." action="Add the item body" onAction={beginEdit} />
    );
  } else if (annotationsLinked && bodyIssueDocument) {
    bodyContent = (
      <IssueDocumentAnnotations
        issueId={conversationIssueId!}
        doc={bodyIssueDocument}
        bodyMarkdown={displayedBody}
        draftDirty={false}
        draftConflicted={false}
        historicalPreview={false}
        locationHash={locationHash}
        panelOpen={panelOpen}
        onPanelOpenChange={setPanelOpen}
        agentMap={agentMap}
        userProfileMap={userProfileMap}
        initialComposerAnchor={pendingStartAnchor}
        onInitialComposerAnchorConsumed={() => setPendingStartAnchor(null)}
      >
        {renderReadOnlyBody(displayedBody)}
      </IssueDocumentAnnotations>
    );
  } else {
    // Has a saved body but no conversation/link yet: allow selecting text to start one.
    bodyContent = (
      <section
        ref={(element) => {
          containerRef.current = element;
        }}
        className="relative min-w-0"
        data-testid="pipeline-item-body-unlinked"
      >
        <div className="relative z-[1]">{renderReadOnlyBody(displayedBody)}</div>
        <DocumentAnnotationLayer
          containerRef={containerRef}
          markdown={displayedBody}
          threads={[]}
          focusedThreadId={null}
          onThreadFocus={() => {}}
          pendingAnchor={selectionAnchor}
          onPendingAnchorChange={setSelectionAnchor}
          onRequestComment={(anchor) => void handleStartConversationFromAnchor(anchor)}
          hideResolved
        />
      </section>
    );
  }

  return (
    <section
      aria-label="Item body"
      id="pipeline-item-body-document"
      data-testid="pipeline-item-body-document"
      className="rounded-lg border border-border p-3"
    >
      <DocumentFrameHeader
        documentKey={BODY_DOCUMENT_KEY}
        documentLabel="Item body document"
        folded={folded}
        onToggleFolded={() => setFolded((value) => !value)}
        revisionMenu={hasDocument ? {
          open: revisionMenuOpen,
          onOpenChange: setRevisionMenuOpen,
          loading: revisionsQuery.isFetching,
          revisions: revisions.map((revision) => ({
            id: revision.id,
            revisionNumber: revision.revisionNumber,
            createdAt: revision.createdAt,
            actorLabel: revision.createdByUserId ? "board" : revision.createdByAgentId ? "agent" : "system",
          })),
          selectedRevisionId,
          currentRevisionId: doc?.latestRevisionId ?? null,
          displayedRevisionNumber,
          historicalPreview: isHistoricalPreview,
          onSelectRevision: (revisionId: string, isCurrent: boolean) => setSelectedRevisionId(isCurrent ? null : revisionId),
        } : undefined}
        updatedAt={hasDocument ? doc?.updatedAt : null}
        updatedHref="#pipeline-item-body-document"
        annotationSlot={annotationsLinked && conversationIssueId ? (
          <DocumentAnnotationsCountChip
            issueId={conversationIssueId}
            docKey={PIPELINE_CASE_BODY_DOCUMENT_KEY}
            panelOpen={panelOpen}
            onToggle={() => setPanelOpen((value) => !value)}
          />
        ) : null}
        actionsSlot={editing ? (
          <span className="text-[11px] font-medium text-amber-300">● Editing · unsaved</span>
        ) : (
          <Button variant="ghost" size="sm" className="h-auto gap-1.5 px-2 py-1 text-xs" onClick={beginEdit}>
            <FilePenLine className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      />

      {!folded ? <div className="mt-3 space-y-3">{bodyContent}</div> : null}
    </section>
  );
}
