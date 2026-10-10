import { Profiler, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, DocumentAnnotationThreadWithComments, IssueDocument } from "@paperclipai/shared";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { queryKeys } from "@/lib/queryKeys";
import { parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import {
  initializeSelectionDebug,
  isSelectionDebugEnabled,
  recordAnnotationCommit,
} from "@/lib/document-annotation-debug";
import { DocumentAnnotationLayer, type AnnotationAnchorRect, type PendingAnchor } from "./DocumentAnnotationLayer";
import { DocumentAnnotationPanel } from "./DocumentAnnotationPanel";
import { DocumentAnnotationPopover } from "./DocumentAnnotationPopover";
import type { CompanyUserProfile } from "@/lib/company-members";

// Width of the right-hand comment gutter on desktop (lg+). The gutter is an
// in-flow flex column beside the document, so it scrolls with the doc instead
// of floating over the viewport (PAP-504).
const DESKTOP_ANNOTATION_PANEL_WIDTH = 360;

type AnnotationDocument = Pick<IssueDocument, "key" | "latestRevisionId" | "latestRevisionNumber">;

export interface IssueDocumentAnnotationsProps {
  issueId: string;
  doc: AnnotationDocument;
  target?: DocumentAnnotationTarget;
  /** The body that is being rendered/edited (current or historical revision). */
  bodyMarkdown: string;
  /** True when a draft has unsaved changes or is currently saving. */
  draftDirty: boolean;
  /** True when there is a remote conflict that requires user resolution. */
  draftConflicted: boolean;
  /** True when the document is being viewed in historical revision preview. */
  historicalPreview: boolean;
  /** Render the document body (rendered MarkdownBody or MarkdownEditor) inside the wrapper. */
  children: ReactNode;
  /** Current location hash so we can resolve deep-link targets. */
  locationHash: string;
  /** Controlled panel state. Caller owns this so the count chip can live in the doc header. */
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  /** Keep the panel in document flow for narrow hosts such as the task properties pane. */
  panelPlacement?: "floating" | "inline" | "popover";
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
  /** Seed which thread is focused on mount. Used by Storybook/screenshot harness. */
  defaultFocusedThreadId?: string;
  /**
   * Seed the composer with a pending anchor and open the panel once. Used when
   * a host captures a selection before the annotated document wrapper exists.
   */
  initialComposerAnchor?: PendingAnchor | null;
  onInitialComposerAnchorConsumed?: () => void;
}

export function IssueDocumentAnnotations({
  issueId,
  doc,
  target,
  bodyMarkdown,
  draftDirty,
  draftConflicted,
  historicalPreview,
  children,
  locationHash,
  panelOpen,
  onPanelOpenChange,
  panelPlacement = "floating",
  agentMap,
  userProfileMap,
  defaultFocusedThreadId,
  initialComposerAnchor,
  onInitialComposerAnchorConsumed,
}: IssueDocumentAnnotationsProps) {
  const selectionDebugEnabled = isSelectionDebugEnabled();
  if (selectionDebugEnabled) initializeSelectionDebug();
  const containerRef = useRef<HTMLElement | null>(null);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(defaultFocusedThreadId ?? null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<PendingAnchor | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<PendingAnchor | null>(null);
  const [popoverAnchorRect, setPopoverAnchorRect] = useState<AnnotationAnchorRect | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const hashHandledRef = useRef<string | null>(null);
  // Bus token to ask the body layer to capture the current selection into a pendingAnchor.
  const [captureSelectionRequestId, setCaptureSelectionRequestId] = useState(0);
  const consumedInitialAnchorRef = useRef<PendingAnchor | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const handler = () => setIsMobile(mediaQuery.matches);
    handler();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
    return undefined;
  }, []);

  const annotationsQuery = useQuery({
    queryKey: target?.kind === "routine"
      ? queryKeys.routines.documentAnnotations(target.routineId, target.documentKey, "all")
      : target?.kind === "case"
        ? queryKeys.cases.documentAnnotations(target.caseId, target.documentKey, "all")
      : queryKeys.issues.documentAnnotations(issueId, doc.key, "all"),
    queryFn: () => target
      ? documentAnnotationsApi.listForTarget(target, { status: "all", includeComments: true })
      : documentAnnotationsApi.list(issueId, doc.key, { status: "all", includeComments: true }),
    staleTime: 30_000,
  });
  const allThreads = annotationsQuery.data ?? [];

  // Resolve deep link `#document-<key>&thread=...&comment=...` once per change.
  useEffect(() => {
    if (!locationHash) return;
    if (hashHandledRef.current === locationHash) return;
    const target = parseDocumentAnnotationHash(locationHash);
    if (!target || target.documentKey !== doc.key) return;
    if (!target.threadId) return;
    hashHandledRef.current = locationHash;
    onPanelOpenChange(true);
    setFocusedThreadId(target.threadId);
    setFocusedCommentId(target.commentId);
  }, [doc.key, locationHash, onPanelOpenChange]);

  const newCommentDisabled = draftDirty || draftConflicted || historicalPreview || !doc.latestRevisionId;
  const newCommentDisabledReason = historicalPreview
    ? "New comments are disabled while previewing a historical revision."
    : draftConflicted
      ? "Resolve the document conflict before adding new comments."
      : draftDirty
        ? "Save the draft to anchor new comments."
        : !doc.latestRevisionId
          ? "Document has no saved revision yet."
          : null;

  const handleSelectionAnchorChange = useCallback((anchor: PendingAnchor | null) => {
    setSelectionAnchor(anchor);
    if (anchor && panelPlacement === "popover") {
      setComposerAnchor(null);
      setFocusedThreadId(null);
      setPopoverAnchorRect(null);
      onPanelOpenChange(false);
    }
  }, [onPanelOpenChange, panelPlacement]);

  const handleClearComposerAnchor = useCallback(() => {
    setSelectionAnchor(null);
    setComposerAnchor(null);
    setPopoverAnchorRect(null);
  }, []);

  const handleRequestComment = useCallback((anchor: PendingAnchor, rect?: AnnotationAnchorRect) => {
    if (newCommentDisabled) return;
    setSelectionAnchor(null);
    setComposerAnchor(anchor);
    setFocusedThreadId(null);
    if (rect) setPopoverAnchorRect(rect);
    onPanelOpenChange(true);
  }, [newCommentDisabled, onPanelOpenChange]);

  useEffect(() => {
    if (!initialComposerAnchor) return;
    if (consumedInitialAnchorRef.current === initialComposerAnchor) return;
    if (newCommentDisabled) return;
    consumedInitialAnchorRef.current = initialComposerAnchor;
    setComposerAnchor(initialComposerAnchor);
    onPanelOpenChange(true);
    onInitialComposerAnchorConsumed?.();
  }, [initialComposerAnchor, newCommentDisabled, onInitialComposerAnchorConsumed, onPanelOpenChange]);

  const handleThreadFocus = useCallback((threadId: string | null, rect?: AnnotationAnchorRect) => {
    setFocusedThreadId(threadId);
    if (threadId) {
      setComposerAnchor(null);
      if (rect) setPopoverAnchorRect(rect);
      onPanelOpenChange(true);
      setFocusedCommentId(null);
    }
  }, [onPanelOpenChange]);

  const handleAnchorRectChange = useCallback((rect: AnnotationAnchorRect | null) => {
    setPopoverAnchorRect((current) => isSameAnchorRect(current, rect) ? current : rect);
  }, []);

  const handleRequestCommentFromSelection = useCallback(() => {
    if (newCommentDisabled) return;
    if (selectionAnchor) {
      handleRequestComment(selectionAnchor);
      return;
    }
    // Trigger the layer to re-read the current selection and emit a pendingAnchor.
    setCaptureSelectionRequestId((current) => current + 1);
  }, [handleRequestComment, newCommentDisabled, selectionAnchor]);

  // ⌘⇧M / Ctrl+Shift+M global shortcut while the panel is open.
  useEffect(() => {
    if (!panelOpen) return;
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const isMeta = event.metaKey || event.ctrlKey;
      if (!isMeta || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "m") return;
      event.preventDefault();
      handleRequestCommentFromSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen, handleRequestCommentFromSelection]);

  const focusedThread = useMemo(() => {
    if (!focusedThreadId) return null;
    return allThreads.find((thread) => thread.id === focusedThreadId) ?? null;
  }, [allThreads, focusedThreadId]);

  const overlayThreads = useMemo(
    () => allThreads.map((thread) => ({
      id: thread.id,
      selectedText: thread.selectedText,
      status: thread.status,
      anchorState: thread.anchorState,
    })),
    [allThreads],
  );

  const isInlinePlacement = panelPlacement === "inline";
  const isPopoverPlacement = panelPlacement === "popover";
  const showPopover = panelOpen && isPopoverPlacement && !isMobile
    && Boolean(popoverAnchorRect && (composerAnchor || focusedThread));
  // On desktop (lg+) the panel docks into an in-flow gutter column beside the
  // document so it scrolls with the doc rather than floating over the viewport.
  const showDesktopGutter = panelOpen && !isInlinePlacement && !isPopoverPlacement && !isMobile;

  const annotationPanel = panelOpen ? (
    <DocumentAnnotationPanel
      open={panelOpen}
      onOpenChange={(open) => {
        onPanelOpenChange(open);
        if (!open) {
          setSelectionAnchor(null);
          setComposerAnchor(null);
          setFocusedThreadId(null);
          setFocusedCommentId(null);
        }
      }}
      issueId={issueId}
      target={target}
      documentKey={doc.key}
      documentRevisionNumber={doc.latestRevisionNumber}
      baseRevisionId={doc.latestRevisionId}
      baseRevisionNumber={doc.latestRevisionNumber}
      threads={allThreads as DocumentAnnotationThreadWithComments[]}
      focusedThreadId={focusedThreadId}
      focusedCommentId={focusedCommentId}
      onFocusThread={(id) => {
        setFocusedThreadId(id);
        if (!id) setFocusedCommentId(null);
      }}
      pendingAnchor={composerAnchor}
      onClearPendingAnchor={handleClearComposerAnchor}
      onRequestCommentFromSelection={handleRequestCommentFromSelection}
      newCommentDisabled={newCommentDisabled}
      newCommentDisabledReason={newCommentDisabledReason}
      isMobile={isMobile}
      inline={isInlinePlacement || isPopoverPlacement}
      desktopWidth={showDesktopGutter ? DESKTOP_ANNOTATION_PANEL_WIDTH : undefined}
      agentMap={agentMap}
      userProfileMap={userProfileMap}
    />
  ) : null;

  const content = (
    <div
      className={cn(
        "paperclip-doc-annotation-host relative",
        // Docked desktop gutter: lay the doc and the comment column side by side
        // so the panel is part of the document's scroll flow (Google-Docs style).
        showDesktopGutter && "lg:flex lg:items-stretch lg:gap-6",
      )}
    >
      <section
        ref={(element) => {
          containerRef.current = element;
        }}
        className={cn("relative min-w-0", showDesktopGutter && "lg:flex-1")}
        data-testid={`document-annotation-body-${doc.key}`}
      >
        <div className="relative z-(--z-1)">
          {children}
        </div>
        {!historicalPreview && doc.latestRevisionId ? (
          <DocumentAnnotationLayer
            containerRef={containerRef}
            markdown={bodyMarkdown}
            threads={overlayThreads}
            focusedThreadId={focusedThread?.id ?? null}
            onThreadFocus={handleThreadFocus}
            pendingAnchor={selectionAnchor}
            onPendingAnchorChange={handleSelectionAnchorChange}
            onRequestComment={handleRequestComment}
            onAnchorRectChange={isPopoverPlacement && panelOpen && (composerAnchor || focusedThreadId)
              ? handleAnchorRectChange
              : undefined}
            newCommentDisabled={newCommentDisabled}
            newCommentDisabledReason={newCommentDisabledReason}
            hideResolved
            captureSelectionRequestId={captureSelectionRequestId}
            pendingHighlightText={composerAnchor?.selectedText ?? null}
          />
        ) : null}
        {showPopover && popoverAnchorRect ? (
          <DocumentAnnotationPopover
            anchorRect={popoverAnchorRect}
            containerRef={containerRef}
            target={target ?? { kind: "issue", issueId, documentKey: doc.key }}
            documentKey={doc.key}
            baseRevisionId={doc.latestRevisionId}
            baseRevisionNumber={doc.latestRevisionNumber}
            pendingAnchor={composerAnchor}
            thread={focusedThread as DocumentAnnotationThreadWithComments | null}
            focusedCommentId={focusedCommentId}
            onFocusThread={setFocusedThreadId}
            onClose={() => {
              setComposerAnchor(null);
              setFocusedThreadId(null);
              setFocusedCommentId(null);
              setPopoverAnchorRect(null);
              onPanelOpenChange(false);
            }}
            onThreadCreated={() => {
              setComposerAnchor(null);
              setPopoverAnchorRect(null);
              onPanelOpenChange(false);
            }}
            newCommentDisabled={newCommentDisabled}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
          />
        ) : null}
      </section>
      {panelOpen && (isInlinePlacement || (isPopoverPlacement && !showPopover)) && !isMobile ? (
        <div className="mt-3" data-testid="document-annotation-panel-inline">
          {annotationPanel}
        </div>
      ) : null}
      {showDesktopGutter ? (
        <div
          data-testid="document-annotation-panel-anchor"
          className="hidden shrink-0 lg:block"
          style={{ width: DESKTOP_ANNOTATION_PANEL_WIDTH }}
        >
          {/* Sticky within the gutter: stays beside the highlighted range while
              the document is on screen, then scrolls away with the doc. */}
          <div className="sticky top-4">
            {annotationPanel}
          </div>
        </div>
      ) : null}
      {panelOpen && isMobile ? annotationPanel : null}
    </div>
  );

  return selectionDebugEnabled ? (
    <Profiler id="IssueDocumentAnnotations" onRender={recordAnnotationCommit}>
      {content}
    </Profiler>
  ) : content;
}

function isSameAnchorRect(a: AnnotationAnchorRect | null, b: AnnotationAnchorRect | null): boolean {
  return a === b || Boolean(a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);
}

export interface DocumentAnnotationsCountChipProps {
  issueId: string;
  docKey: string;
  target?: DocumentAnnotationTarget;
  panelOpen: boolean;
  onToggle: () => void;
}

/**
 * Renders the unresolved-count chip for a document. Lives in the document header row
 * (next to `rev N ▾`) so it stays visible when the document is folded.
 */
export function DocumentAnnotationsCountChip({
  issueId,
  docKey,
  target,
  panelOpen,
  onToggle,
}: DocumentAnnotationsCountChipProps) {
  const annotationsQuery = useQuery({
    queryKey: target?.kind === "routine"
      ? queryKeys.routines.documentAnnotations(target.routineId, target.documentKey, "all")
      : target?.kind === "case"
        ? queryKeys.cases.documentAnnotations(target.caseId, target.documentKey, "all")
      : queryKeys.issues.documentAnnotations(issueId, docKey, "all"),
    queryFn: () => target
      ? documentAnnotationsApi.listForTarget(target, { status: "all", includeComments: true })
      : documentAnnotationsApi.list(issueId, docKey, { status: "all", includeComments: true }),
    staleTime: 30_000,
  });
  const threads = annotationsQuery.data ?? [];
  const openCount = useMemo(
    () => threads.filter((thread) => thread.status === "open" && thread.anchorState !== "orphaned").length,
    [threads],
  );

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-state={panelOpen ? "open" : "closed"}
      className={cn(
        "h-auto gap-1 rounded-md px-1.5 py-0 text-(length:--text-micro) font-normal text-muted-foreground hover:text-foreground",
        panelOpen && "bg-muted text-foreground",
        openCount > 0 && "text-foreground",
      )}
      onClick={onToggle}
      data-testid={`document-annotation-count-${docKey}`}
      aria-label={openCount === 0
        ? `Open comments on ${docKey}`
        : `Open ${openCount} unresolved comments on ${docKey}`}
      aria-expanded={panelOpen}
    >
      <MessageSquare className="h-3 w-3" aria-hidden="true" />
      <span className="tabular-nums">{openCount}</span>
      <span className="hidden sm:inline">
        {openCount === 1 ? "comment" : "comments"}
      </span>
    </Button>
  );
}
