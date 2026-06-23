import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, DocumentAnnotationThreadWithComments, IssueDocument } from "@paperclipai/shared";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { queryKeys } from "@/lib/queryKeys";
import { parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import { DocumentAnnotationLayer, type PendingAnchor } from "./DocumentAnnotationLayer";
import { DocumentAnnotationPanel } from "./DocumentAnnotationPanel";
import type { CompanyUserProfile } from "@/lib/company-members";

const DESKTOP_ANNOTATION_PANEL_WIDTH = 360;
const DESKTOP_ANNOTATION_PANEL_MIN_WIDTH = 280;
const DESKTOP_ANNOTATION_PANEL_GAP = 24;
const DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN = 16;

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
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
  /** Seed which thread is focused on mount. Used by Storybook/screenshot harness. */
  defaultFocusedThreadId?: string;
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
  agentMap,
  userProfileMap,
  defaultFocusedThreadId,
}: IssueDocumentAnnotationsProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(defaultFocusedThreadId ?? null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<PendingAnchor | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<PendingAnchor | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [desktopPanelFrame, setDesktopPanelFrame] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    width: number;
  } | null>(null);
  const hashHandledRef = useRef<string | null>(null);
  // Bus token to ask the body layer to capture the current selection into a pendingAnchor.
  const [captureSelectionRequestId, setCaptureSelectionRequestId] = useState(0);

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

  useEffect(() => {
    if (!panelOpen || isMobile || typeof window === "undefined") {
      setDesktopPanelFrame(null);
      return;
    }

    const updatePanelFrame = () => {
      const container = containerRef.current;
      const rect = container?.getBoundingClientRect();
      if (!container || !rect) {
        setDesktopPanelFrame(null);
        return;
      }
      const boundaryRect = container.closest("main")?.getBoundingClientRect();
      const boundaryLeft = boundaryRect?.left ?? 0;
      const boundaryRight = boundaryRect?.right ?? window.innerWidth;
      const boundaryWidth = Math.max(0, boundaryRight - boundaryLeft);
      const maxPanelWidth = Math.max(
        DESKTOP_ANNOTATION_PANEL_MIN_WIDTH,
        boundaryWidth - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN * 2,
      );
      const desiredWidth = Math.min(DESKTOP_ANNOTATION_PANEL_WIDTH, maxPanelWidth);
      // Clamp the panel below the sticky top nav (the scroll container's top edge)
      // so the comments thread never tucks under the nav bar while scrolling.
      const boundaryTop = boundaryRect?.top ?? DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN;
      const minTop = Math.max(DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN, boundaryTop)
        + DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN;
      const top = Math.max(minTop, rect.top);
      const desiredLeft = rect.right + DESKTOP_ANNOTATION_PANEL_GAP;
      const spaceRightOfDocument = boundaryRight
        - desiredLeft
        - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN;
      const width = spaceRightOfDocument >= DESKTOP_ANNOTATION_PANEL_MIN_WIDTH
        ? Math.min(desiredWidth, spaceRightOfDocument)
        : desiredWidth;
      const maxVisibleLeft = boundaryRight
        - width
        - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN;
      setDesktopPanelFrame({
        left: Math.max(
          boundaryLeft + DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN,
          Math.min(desiredLeft, maxVisibleLeft),
        ),
        top,
        width,
        maxHeight: Math.max(240, window.innerHeight - top - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN),
      });
    };

    updatePanelFrame();
    window.addEventListener("resize", updatePanelFrame);
    window.addEventListener("scroll", updatePanelFrame, true);
    const resizeObserver = typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(updatePanelFrame)
      : null;
    const observedContainer = containerRef.current;
    if (resizeObserver && observedContainer) {
      resizeObserver.observe(observedContainer);
      const main = observedContainer.closest("main");
      if (main) resizeObserver.observe(main);
    }
    return () => {
      window.removeEventListener("resize", updatePanelFrame);
      window.removeEventListener("scroll", updatePanelFrame, true);
      resizeObserver?.disconnect();
    };
  }, [doc.key, isMobile, panelOpen]);

  const annotationsQuery = useQuery({
    queryKey: target?.kind === "routine"
      ? queryKeys.routines.documentAnnotations(target.routineId, target.documentKey, "all")
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
  }, []);

  const handleClearComposerAnchor = useCallback(() => {
    setSelectionAnchor(null);
    setComposerAnchor(null);
  }, []);

  const handleRequestComment = useCallback((anchor: PendingAnchor) => {
    if (newCommentDisabled) return;
    setSelectionAnchor(null);
    setComposerAnchor(anchor);
    onPanelOpenChange(true);
  }, [newCommentDisabled, onPanelOpenChange]);

  const handleThreadFocus = useCallback((threadId: string | null) => {
    setFocusedThreadId(threadId);
    if (threadId) {
      onPanelOpenChange(true);
      setFocusedCommentId(null);
    }
  }, [onPanelOpenChange]);

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

  const fallbackDesktopPanelFrame = useMemo(() => {
    if (!panelOpen || isMobile || desktopPanelFrame || typeof window === "undefined") return null;
    const width = Math.min(
      DESKTOP_ANNOTATION_PANEL_WIDTH,
      Math.max(
        DESKTOP_ANNOTATION_PANEL_MIN_WIDTH,
        window.innerWidth - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN * 2,
      ),
    );
    return {
      left: Math.max(
        DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN,
        window.innerWidth - width - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN,
      ),
      top: DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN,
      maxHeight: Math.max(
        240,
        window.innerHeight - DESKTOP_ANNOTATION_PANEL_VIEWPORT_MARGIN * 2,
      ),
      width,
    };
  }, [desktopPanelFrame, isMobile, panelOpen]);
  const renderedDesktopPanelFrame = desktopPanelFrame ?? fallbackDesktopPanelFrame;

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
      desktopWidth={renderedDesktopPanelFrame?.width}
      agentMap={agentMap}
      userProfileMap={userProfileMap}
    />
  ) : null;

  return (
    <div className="paperclip-doc-annotation-host relative">
      <section
        ref={(element) => {
          containerRef.current = element;
        }}
        className="relative min-w-0"
        data-testid={`document-annotation-body-${doc.key}`}
      >
        <div className="relative z-[1]">
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
            newCommentDisabled={newCommentDisabled}
            newCommentDisabledReason={newCommentDisabledReason}
            hideResolved
            captureSelectionRequestId={captureSelectionRequestId}
            pendingHighlightText={composerAnchor?.selectedText ?? null}
          />
        ) : null}
      </section>
      {panelOpen && !isMobile && renderedDesktopPanelFrame ? (
        <div
          data-testid="document-annotation-panel-anchor"
          className="pointer-events-auto fixed z-[60] hidden lg:block"
          style={{
            left: renderedDesktopPanelFrame.left,
            maxHeight: renderedDesktopPanelFrame.maxHeight,
            top: renderedDesktopPanelFrame.top,
            width: renderedDesktopPanelFrame.width,
          }}
        >
          {annotationPanel}
        </div>
      ) : null}
      {panelOpen && isMobile ? annotationPanel : null}
    </div>
  );
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
        "h-auto gap-1 rounded-md px-1.5 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground",
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
