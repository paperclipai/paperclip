import { Profiler, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MessageSquare, MessageSquarePlus } from "lucide-react";
import type {
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildAnchorFromContainerSelection,
  getContainerTextOffset,
  isCoarsePointerDevice,
  rangesForNormalizedSpan,
} from "@/lib/document-annotation-selection";
import {
  initializeSelectionDebug,
  isSelectionDebugEnabled,
  recordAnnotationCommit,
  recordCaptureSelection,
  recordMarkdownMutations,
  recordSelectionChange,
} from "@/lib/document-annotation-debug";
import type { DocumentAnnotationAnchorSelector } from "@paperclipai/shared";

export interface AnnotationOverlayThread {
  id: string;
  selectedText: string;
  status: DocumentAnnotationThreadStatus;
  anchorState: DocumentAnnotationAnchorState;
  unreadCount?: number;
}

export interface PendingAnchor {
  selector: DocumentAnnotationAnchorSelector;
  selectedText: string;
}

export interface AnnotationLayerProps {
  containerRef: React.RefObject<HTMLElement | null>;
  markdown: string;
  threads: AnnotationOverlayThread[];
  focusedThreadId: string | null;
  onThreadFocus: (threadId: string) => void;
  /** Tracks the most recently captured pending selection. */
  pendingAnchor: PendingAnchor | null;
  onPendingAnchorChange: (anchor: PendingAnchor | null) => void;
  onRequestComment: (anchor: PendingAnchor) => void;
  /** Disables the "add comment" affordance when set. */
  newCommentDisabled?: boolean;
  newCommentDisabledReason?: string | null;
  /** Hide resolved highlights even when included in the threads list. */
  hideResolved?: boolean;
  /** Test-only: override window object for layout calculations. */
  testWindow?: { innerWidth: number; innerHeight: number };
  /**
   * When this number changes, re-read the current document selection and emit a
   * pending anchor for the keyboard shortcut path.
   */
  captureSelectionRequestId?: number;
  /**
   * Text of a comment currently being composed. We keep this segment brightly
   * highlighted in the document even after the native browser selection is lost
   * (e.g. once focus moves into the composer textarea).
   */
  pendingHighlightText?: string | null;
}

/** Synthetic thread id used to render the in-progress (pending) comment highlight. */
const PENDING_HIGHLIGHT_THREAD_ID = "__paperclip-pending-annotation__";
const COARSE_SELECTION_SETTLE_MS = 400;
const COARSE_GESTURE_END_CAPTURE_MS = 120;
const FINE_SELECTION_SETTLE_MS = 120;
const TOOLBAR_FALLBACK_WIDTH = 120;
const TOOLBAR_HEIGHT = 36;
const TOOLBAR_VIEWPORT_GAP = 8;
const TOUCH_CALLOUT_GAP = 12;

interface HighlightRect {
  threadId: string;
  status: DocumentAnnotationThreadStatus;
  anchorState: DocumentAnnotationAnchorState;
  top: number;
  left: number;
  width: number;
  height: number;
  /** True for the last rect of this thread (used to anchor a glyph at the run end). */
  isTail: boolean;
  /** True when this run should render with the brighter focused/pending treatment. */
  focused: boolean;
}

interface ToolbarPosition {
  top: number;
  left: number;
}

interface SelectionSnapshot {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  selectedText: string;
}

type NativeHighlightKind = "open" | "focused" | "stale" | "resolved";

type NativeHighlightRanges = Record<NativeHighlightKind, Range[]>;

type CssHighlight = object;

type HighlightConstructor = new (...ranges: Range[]) => CssHighlight;

type HighlightRegistry = {
  set: (name: string, highlight: CssHighlight) => void;
  delete: (name: string) => void;
};

const NATIVE_HIGHLIGHT_NAMES: Record<NativeHighlightKind, string> = {
  open: "paperclip-doc-annotation-open",
  focused: "paperclip-doc-annotation-focused",
  stale: "paperclip-doc-annotation-stale",
  resolved: "paperclip-doc-annotation-resolved",
};

const nativeHighlightInstances = new Map<string, NativeHighlightRanges>();

function getNativeHighlightApi(): { registry: HighlightRegistry; HighlightCtor: HighlightConstructor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const HighlightCtor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css?.highlights || typeof HighlightCtor !== "function") return null;
  return { registry: css.highlights, HighlightCtor };
}

function emptyNativeHighlightRanges(): NativeHighlightRanges {
  return {
    open: [],
    focused: [],
    stale: [],
    resolved: [],
  };
}

function syncNativeHighlights(api = getNativeHighlightApi()) {
  if (!api) return;
  for (const kind of Object.keys(NATIVE_HIGHLIGHT_NAMES) as NativeHighlightKind[]) {
    const ranges = Array.from(nativeHighlightInstances.values()).flatMap((entry) => entry[kind]);
    const name = NATIVE_HIGHLIGHT_NAMES[kind];
    if (ranges.length === 0) {
      api.registry.delete(name);
    } else {
      api.registry.set(name, new api.HighlightCtor(...ranges));
    }
  }
}

function setNativeHighlightRanges(instanceId: string, ranges: NativeHighlightRanges) {
  if (!getNativeHighlightApi()) return;
  nativeHighlightInstances.set(instanceId, ranges);
  syncNativeHighlights();
}

function clearNativeHighlightRanges(instanceId: string) {
  if (!nativeHighlightInstances.delete(instanceId)) return;
  syncNativeHighlights();
}

function elementFromNode(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null;
  if (node instanceof HTMLElement) return node;
  const parent = node.parentElement;
  return parent instanceof HTMLElement ? parent : null;
}

function selectionTouchesEditableElement(container: HTMLElement, range: Range) {
  for (const node of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
    const element = elementFromNode(node);
    if (!element || !container.contains(element)) continue;
    const editableElement = element.closest("input, textarea, select, [contenteditable]");
    if (!(editableElement instanceof HTMLElement)) continue;
    if (editableElement.matches("input, textarea, select")) return true;
    const contentEditableValue = editableElement.getAttribute("contenteditable");
    if (
      editableElement.isContentEditable ||
      (contentEditableValue !== null && contentEditableValue.toLowerCase() !== "false")
    ) {
      return true;
    }
  }
  return false;
}

function intersectRects(a: DOMRect, b: DOMRect): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function clipsOverflow(element: HTMLElement) {
  if (element.classList.contains("fold-curtain__content")) return true;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return false;
  const style = window.getComputedStyle(element);
  return [style.overflow, style.overflowX, style.overflowY].some((value) =>
    value === "hidden" || value === "clip" || value === "auto" || value === "scroll",
  );
}

function visibleClipRectForRange(range: Range, container: HTMLElement): DOMRect | null {
  let clipRect = container.getBoundingClientRect();
  let element = elementFromNode(range.commonAncestorContainer);
  while (element) {
    if (clipsOverflow(element)) {
      const nextClipRect = intersectRects(clipRect, element.getBoundingClientRect());
      if (!nextClipRect) return null;
      clipRect = nextClipRect;
    }
    if (element === container) break;
    element = element.parentElement;
  }
  return clipRect;
}

function nativeHighlightKind(input: {
  focused: boolean;
  stale: boolean;
  resolved: boolean;
}): NativeHighlightKind {
  if (input.resolved) return "resolved";
  if (input.stale) return "stale";
  if (input.focused) return "focused";
  return "open";
}

function selectionRangeInsideContainer(selection: Selection | null, container: HTMLElement | null): Range | null {
  if (!selection || !container || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return container.contains(range.commonAncestorContainer) ? range : null;
}

function isAnnotationLayerMutation(mutation: MutationRecord) {
  const target = elementFromNode(mutation.target);
  return Boolean(
    target?.closest(
      ".paperclip-doc-annotation-layer, .paperclip-doc-annotation-visual-layer, .paperclip-doc-annotation-selection-toolbar",
    ),
  );
}

export function DocumentAnnotationLayer({
  containerRef,
  markdown,
  threads,
  focusedThreadId,
  onThreadFocus,
  pendingAnchor,
  onPendingAnchorChange,
  onRequestComment,
  newCommentDisabled = false,
  newCommentDisabledReason = null,
  hideResolved = true,
  captureSelectionRequestId,
  pendingHighlightText = null,
  testWindow,
}: AnnotationLayerProps) {
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([]);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null);
  const [coarsePointer, setCoarsePointer] = useState(() =>
    typeof window === "undefined" ? false : isCoarsePointerDevice(),
  );
  const [selectionGestureActive, setSelectionGestureActive] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarAnchorRangeRef = useRef<Range | null>(null);
  const lastCaptureSelectionRequestIdRef = useRef<number>(0);
  const selectionCaptureTimeoutRef = useRef<number | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionGestureIdleTimeoutRef = useRef<number | null>(null);
  const pendingHighlightSyncRef = useRef(false);
  const lastProcessedSelectionRef = useRef<SelectionSnapshot | null>(null);
  const hasProcessedSelectionRef = useRef(false);
  const reactId = useId();
  const nativeHighlightInstanceId = useMemo(
    () => `document-annotation-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const nativeHighlightsSupported = getNativeHighlightApi() !== null;
  const selectionDebugEnabled = isSelectionDebugEnabled();
  if (selectionDebugEnabled) initializeSelectionDebug();

  const visibleThreads = useMemo(() => {
    if (!hideResolved) return threads;
    return threads.filter((thread) => thread.status !== "resolved" || thread.anchorState === "orphaned" || thread.id === focusedThreadId);
  }, [threads, hideResolved, focusedThreadId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateCoarsePointer = () => setCoarsePointer(isCoarsePointerDevice());
    updateCoarsePointer();
    const pointerQuery = typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)")
      : null;
    if (!pointerQuery) return;
    pointerQuery.addEventListener?.("change", updateCoarsePointer);
    pointerQuery.addListener?.(updateCoarsePointer);
    return () => {
      pointerQuery.removeEventListener?.("change", updateCoarsePointer);
      pointerQuery.removeListener?.(updateCoarsePointer);
    };
  }, []);

  const computeHighlightRects = useCallback((options?: { force?: boolean }) => {
    if (!options?.force && selectionGestureActiveRef.current) {
      pendingHighlightSyncRef.current = true;
      return;
    }
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) {
      clearNativeHighlightRanges(nativeHighlightInstanceId);
      setHighlightRects([]);
      return;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const next: HighlightRect[] = [];
    const nativeRanges = emptyNativeHighlightRanges();
    const pushRunRects = (run: {
      threadId: string;
      status: DocumentAnnotationThreadStatus;
      anchorState: DocumentAnnotationAnchorState;
      focused: boolean;
      selectedText: string;
      nativeKind: NativeHighlightKind;
    }) => {
      const ranges = rangesForNormalizedSpan({
        container,
        selectedText: run.selectedText,
      });
      const startIndex = next.length;
      for (const range of ranges) {
        const visibleClipRect = visibleClipRectForRange(range, container);
        if (!visibleClipRect) continue;
        let rangeIsVisible = false;
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 || rect.height === 0) continue;
          const visibleRect = intersectRects(rect, visibleClipRect);
          if (!visibleRect) continue;
          rangeIsVisible = true;
          next.push({
            threadId: run.threadId,
            status: run.status,
            anchorState: run.anchorState,
            focused: run.focused,
            top: visibleRect.top - overlayRect.top,
            left: visibleRect.left - overlayRect.left,
            width: visibleRect.width,
            height: visibleRect.height,
            isTail: false,
          });
        }
        if (rangeIsVisible) nativeRanges[run.nativeKind].push(range);
      }
      if (next.length > startIndex) {
        next[next.length - 1].isTail = true;
      }
    };
    for (const thread of visibleThreads) {
      if (thread.anchorState === "orphaned") continue;
      const isFocused = thread.id === focusedThreadId;
      const isStale = thread.anchorState === "stale";
      const isResolved = thread.status === "resolved";
      pushRunRects({
        threadId: thread.id,
        status: thread.status,
        anchorState: thread.anchorState,
        focused: isFocused,
        selectedText: thread.selectedText,
        nativeKind: nativeHighlightKind({ focused: isFocused, stale: isStale, resolved: isResolved }),
      });
    }
    // Keep the in-progress (pending) comment selection brightly highlighted so the
    // segment stays anchored in the document while the composer is open.
    if (pendingHighlightText && pendingHighlightText.trim().length > 0) {
      pushRunRects({
        threadId: PENDING_HIGHLIGHT_THREAD_ID,
        status: "open",
        anchorState: "active",
        focused: true,
        selectedText: pendingHighlightText,
        nativeKind: "focused",
      });
    }
    setNativeHighlightRanges(nativeHighlightInstanceId, nativeRanges);
    setHighlightRects(next);
    pendingHighlightSyncRef.current = false;
  }, [containerRef, focusedThreadId, nativeHighlightInstanceId, pendingHighlightText, visibleThreads]);

  const computeHighlightRectsRef = useRef(computeHighlightRects);

  useEffect(() => {
    computeHighlightRectsRef.current = computeHighlightRects;
  }, [computeHighlightRects]);

  useLayoutEffect(() => {
    computeHighlightRects();
  }, [computeHighlightRects]);

  useEffect(() => () => clearNativeHighlightRanges(nativeHighlightInstanceId), [nativeHighlightInstanceId]);

  const positionToolbar = useCallback((range: Range) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const overlayRect = overlay.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? testWindow?.innerWidth ?? window.innerWidth;
    const viewportHeight = visualViewport?.height ?? testWindow?.innerHeight ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const preferredAboveTop = rect.top - TOOLBAR_HEIGHT - TOOLBAR_VIEWPORT_GAP;
    const preferredBelowTop = rect.bottom + TOUCH_CALLOUT_GAP;
    const screenTop = coarsePointer
      ? preferredBelowTop + TOOLBAR_HEIGHT > viewportBottom
        ? preferredAboveTop
        : preferredBelowTop
      : preferredAboveTop < viewportTop + TOOLBAR_VIEWPORT_GAP
        ? Math.min(rect.bottom + TOOLBAR_VIEWPORT_GAP, viewportBottom - TOOLBAR_HEIGHT - TOOLBAR_VIEWPORT_GAP)
        : preferredAboveTop;
    const toolbarWidth = toolbarRef.current?.offsetWidth || TOOLBAR_FALLBACK_WIDTH;
    const preferredLeft = rect.left + rect.width / 2 - toolbarWidth / 2;
    const screenLeft = Math.min(
      Math.max(preferredLeft, viewportLeft + TOOLBAR_VIEWPORT_GAP),
      viewportLeft + viewportWidth - toolbarWidth - TOOLBAR_VIEWPORT_GAP,
    );
    const nextPosition = {
      top: Math.max(0, screenTop - overlayRect.top),
      left: Math.max(0, screenLeft - overlayRect.left),
    };
    setToolbarPosition((current) =>
      current?.top === nextPosition.top && current.left === nextPosition.left ? current : nextPosition,
    );
  }, [coarsePointer, testWindow]);

  useLayoutEffect(() => {
    if (!pendingAnchor || !toolbarAnchorRangeRef.current) return;
    positionToolbar(toolbarAnchorRangeRef.current);
  }, [pendingAnchor, positionToolbar]);

  useEffect(() => {
    if (!pendingAnchor || !toolbarAnchorRangeRef.current) return;
    const visualViewport = window.visualViewport;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (toolbarAnchorRangeRef.current) positionToolbar(toolbarAnchorRangeRef.current);
      });
    };
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [pendingAnchor, positionToolbar]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    const overlay = overlayRef.current;
    let cancelled = false;
    let frame: number | null = null;

    const schedule = () => {
      if (cancelled || frame !== null) return;
      if (selectionGestureActiveRef.current) {
        pendingHighlightSyncRef.current = true;
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) computeHighlightRects();
      });
    };

    const handleResizeOrScroll = () => schedule();
    window.addEventListener("resize", handleResizeOrScroll);
    window.addEventListener("scroll", handleResizeOrScroll, true);

    const resizeObserver = typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(schedule)
      : null;
    if (resizeObserver && container) resizeObserver.observe(container);
    if (resizeObserver && overlay) resizeObserver.observe(overlay);

    const mutationObserver = typeof window.MutationObserver === "function" && container
      ? new window.MutationObserver((mutations) => {
        if (selectionDebugEnabled) {
          const markdownMutations = mutations.filter((mutation) =>
            Boolean(elementFromNode(mutation.target)?.closest(".paperclip-markdown")),
          );
          if (markdownMutations.length > 0) recordMarkdownMutations(markdownMutations.length);
        }
        const onlyLayerMutations = mutations.every(isAnnotationLayerMutation);
        if (!onlyLayerMutations) schedule();
      })
      : null;
    if (mutationObserver && container) {
      mutationObserver.observe(container, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "data-state", "open", "hidden", "aria-expanded"],
      });
    }

    schedule();

    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", handleResizeOrScroll);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
    };
  }, [computeHighlightRects, containerRef, selectionDebugEnabled]);

  const captureSelection = useCallback((): PendingAnchor | null | undefined => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    if (selectionTouchesEditableElement(container, range)) return null;
    const snapshot: SelectionSnapshot = {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      selectedText: range.toString(),
    };
    const previous = lastProcessedSelectionRef.current;
    if (
      previous
      && previous.startContainer === snapshot.startContainer
      && previous.startOffset === snapshot.startOffset
      && previous.endContainer === snapshot.endContainer
      && previous.endOffset === snapshot.endOffset
      && previous.selectedText === snapshot.selectedText
    ) {
      return undefined;
    }
    lastProcessedSelectionRef.current = snapshot;
    hasProcessedSelectionRef.current = true;
    const containerOffset = getContainerTextOffset(container, range);
    if (!containerOffset) return null;
    const anchor = buildAnchorFromContainerSelection({ markdown, containerOffset });
    if (!anchor) return null;
    toolbarAnchorRangeRef.current = range;
    positionToolbar(range);
    return {
      selector: anchor.selector,
      selectedText: containerOffset.selectedText,
    };
  }, [containerRef, markdown, positionToolbar]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const clearSelectionCaptureTimeout = () => {
      if (selectionCaptureTimeoutRef.current === null) return;
      window.clearTimeout(selectionCaptureTimeoutRef.current);
      selectionCaptureTimeoutRef.current = null;
    };
    const clearSelectionGestureIdleTimeout = () => {
      if (selectionGestureIdleTimeoutRef.current === null) return;
      window.clearTimeout(selectionGestureIdleTimeoutRef.current);
      selectionGestureIdleTimeoutRef.current = null;
    };
    const setSelectionGestureActiveValue = (active: boolean) => {
      selectionGestureActiveRef.current = active;
      setSelectionGestureActive(active);
    };
    const settleSelectionGesture = () => {
      clearSelectionGestureIdleTimeout();
      setSelectionGestureActiveValue(false);
      if (pendingHighlightSyncRef.current) computeHighlightRectsRef.current({ force: true });
    };
    const scheduleSelectionGestureSettle = (delay: number) => {
      clearSelectionGestureIdleTimeout();
      selectionGestureIdleTimeoutRef.current = window.setTimeout(settleSelectionGesture, delay);
    };
    const applySelectionChange = () => {
      const captureStartedAt = selectionDebugEnabled ? performance.now() : 0;
      const anchor = captureSelection();
      if (anchor === undefined) return;
      if (selectionDebugEnabled) {
        recordCaptureSelection(performance.now() - captureStartedAt, Boolean(anchor));
      }
      if (!anchor) {
        if (hasProcessedSelectionRef.current && lastProcessedSelectionRef.current === null) return;
        lastProcessedSelectionRef.current = null;
        hasProcessedSelectionRef.current = true;
        toolbarAnchorRangeRef.current = null;
        onPendingAnchorChange(null);
        setToolbarPosition(null);
        return;
      }
      onPendingAnchorChange(anchor);
    };
    const scheduleSelectionCapture = (delay: number) => {
      clearSelectionCaptureTimeout();
      selectionCaptureTimeoutRef.current = window.setTimeout(() => {
        selectionCaptureTimeoutRef.current = null;
        applySelectionChange();
      }, delay);
    };
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const range = selectionRangeInsideContainer(selection, containerRef.current);
      const selectionIsActive = Boolean(range);
      if (selectionDebugEnabled) recordSelectionChange(selectionIsActive);
      if (selectionIsActive) {
        setSelectionGestureActiveValue(true);
        scheduleSelectionGestureSettle(coarsePointer ? COARSE_SELECTION_SETTLE_MS : FINE_SELECTION_SETTLE_MS);
      } else {
        settleSelectionGesture();
      }
      if (coarsePointer) {
        scheduleSelectionCapture(COARSE_SELECTION_SETTLE_MS);
        return;
      }
      applySelectionChange();
    };
    const handleGestureEnd = () => {
      if (selectionCaptureTimeoutRef.current === null) return;
      scheduleSelectionCapture(COARSE_GESTURE_END_CAPTURE_MS);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    if (coarsePointer) {
      document.addEventListener("pointerup", handleGestureEnd);
      document.addEventListener("touchend", handleGestureEnd);
    }
    return () => {
      clearSelectionCaptureTimeout();
      clearSelectionGestureIdleTimeout();
      selectionGestureActiveRef.current = false;
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerup", handleGestureEnd);
      document.removeEventListener("touchend", handleGestureEnd);
    };
  }, [captureSelection, coarsePointer, containerRef, onPendingAnchorChange, selectionDebugEnabled]);

  useLayoutEffect(() => {
    if (captureSelectionRequestId === undefined) return;
    if (captureSelectionRequestId === 0) return;
    if (lastCaptureSelectionRequestIdRef.current === captureSelectionRequestId) return;
    lastCaptureSelectionRequestIdRef.current = captureSelectionRequestId;
    const anchor = captureSelection();
    const requestedAnchor = anchor === undefined ? pendingAnchor : anchor;
    if (!requestedAnchor) return;
    if (anchor !== undefined) onPendingAnchorChange(anchor);
    onRequestComment(requestedAnchor);
  }, [captureSelectionRequestId, captureSelection, onPendingAnchorChange, onRequestComment, pendingAnchor]);

  const handleAddComment = () => {
    if (pendingAnchor) onRequestComment(pendingAnchor);
  };

  const content = (
    <>
      {!nativeHighlightsSupported ? (
        <div className="paperclip-doc-annotation-visual-layer pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <div className="relative h-full w-full">
            {highlightRects.map((rect, index) => {
              const isFocused = rect.focused;
              const isStale = rect.anchorState === "stale";
              const isResolved = rect.status === "resolved";
              return (
                <span
                  key={`visual-${rect.threadId}-${index}`}
                  data-thread-id={rect.threadId}
                  data-anchor-state={rect.anchorState}
                  data-status={rect.status}
                  data-focused={isFocused || undefined}
                  className={cn(
                    "paperclip-doc-annotation-highlight absolute rounded-none transition-colors",
                    // base box treatment (replaces the previous baseline border)
                    isResolved
                      ? "bg-yellow-100 outline outline-1 outline-dashed outline-offset-0 outline-yellow-700/45 dark:bg-yellow-700 dark:outline-yellow-200/45"
                      : isStale
                        ? "bg-yellow-200 outline outline-2 outline-dashed outline-offset-0 outline-yellow-700/65 dark:bg-yellow-600 dark:outline-yellow-200/70"
                        : isFocused
                          ? "bg-yellow-300 outline outline-2 outline-offset-0 outline-yellow-700/85 shadow-(--shadow-extract-6) dark:bg-yellow-500 dark:outline-yellow-200/85"
                          : "bg-yellow-200 dark:bg-yellow-600",
                  )}
                  style={{
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        className="paperclip-doc-annotation-layer pointer-events-none absolute inset-0 z-(--z-2)"
        aria-hidden="true"
      >
        <div ref={overlayRef} className="relative h-full w-full">
          {highlightRects.map((rect, index) => {
            if (rect.threadId === PENDING_HIGHLIGHT_THREAD_ID) return null;
            const isFocused = rect.focused;
            const isHovered = rect.threadId === hoveredThreadId;
            const hitTargetInteractive = !coarsePointer && !selectionGestureActive;
            return (
              <button
                key={`${rect.threadId}-${index}`}
                type="button"
                data-thread-id={rect.threadId}
                data-anchor-state={rect.anchorState}
                data-status={rect.status}
                data-focused={isFocused || undefined}
                data-hovered={isHovered || undefined}
                aria-label="Open annotation thread"
                className={cn(
                  "paperclip-doc-annotation-hit-target absolute rounded-none bg-transparent transition-colors",
                  hitTargetInteractive ? "pointer-events-auto cursor-pointer" : "pointer-events-none",
                  // Tint the run on hover so it's obvious which highlight you're over.
                  hitTargetInteractive && isHovered && "bg-amber-400/40 dark:bg-amber-300/30",
                  isFocused && "ring-1 ring-transparent",
                )}
                style={{
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                }}
                onMouseEnter={() => setHoveredThreadId(rect.threadId)}
                onMouseLeave={() =>
                  setHoveredThreadId((current) => (current === rect.threadId ? null : current))
                }
                onClick={() => onThreadFocus(rect.threadId)}
              />
            );
          })}
          {coarsePointer
            ? highlightRects.map((rect, index) =>
              rect.isTail && rect.threadId !== PENDING_HIGHLIGHT_THREAD_ID ? (
                <button
                  key={`focus-tail-${rect.threadId}-${index}`}
                  type="button"
                  data-testid="document-annotation-focus-tail"
                  data-thread-id={rect.threadId}
                  aria-label="Open annotation thread"
                  className="paperclip-doc-annotation-focus-tail pointer-events-auto absolute inline-flex items-center justify-center rounded-sm bg-amber-500/95 text-amber-50 shadow-sm dark:bg-amber-500/90 dark:text-amber-50"
                  style={{
                    top: rect.top + Math.max(0, rect.height / 2 - 8),
                    left: rect.left + rect.width + 2,
                    width: 16,
                    height: 16,
                  }}
                  title={rect.anchorState === "stale" ? "Anchor moved — needs review" : "Open annotation thread"}
                  onClick={() => onThreadFocus(rect.threadId)}
                >
                  {rect.anchorState === "stale" ? (
                    <AlertTriangle className="h-3 w-3" />
                  ) : (
                    <MessageSquare className="h-3 w-3" />
                  )}
                </button>
              ) : null,
            )
            : null}
          {highlightRects.map((rect, index) =>
            !coarsePointer && rect.isTail && rect.anchorState === "stale" ? (
              <span
                key={`tail-${rect.threadId}-${index}`}
                aria-hidden="true"
                data-thread-id={rect.threadId}
                className="paperclip-doc-annotation-tail pointer-events-none absolute inline-flex items-center justify-center rounded-sm bg-amber-500/95 text-amber-50 shadow-sm dark:bg-amber-500/90 dark:text-amber-50"
                style={{
                  top: rect.top + Math.max(0, rect.height / 2 - 8),
                  left: rect.left + rect.width + 2,
                  width: 16,
                  height: 16,
                }}
                title="Anchor moved — needs review"
              >
                <AlertTriangle className="h-3 w-3" />
              </span>
            ) : null,
          )}
          {pendingAnchor && toolbarPosition ? (
            <div
              ref={toolbarRef}
              data-testid="document-annotation-selection-toolbar"
              role="toolbar"
              aria-label="Selection actions"
              className="paperclip-doc-annotation-selection-toolbar pointer-events-auto absolute z-10 flex items-center gap-1 rounded-md border border-border bg-popover px-1 py-1 shadow-md"
              style={{ top: toolbarPosition.top, left: toolbarPosition.left }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={handleAddComment}
                disabled={newCommentDisabled}
                title={newCommentDisabled
                  ? newCommentDisabledReason ?? undefined
                  : "Add comment on selection (⌘⇧M)"}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                Comment
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );

  return selectionDebugEnabled ? (
    <Profiler id="DocumentAnnotationLayer" onRender={recordAnnotationCommit}>
      {content}
    </Profiler>
  ) : content;
}
