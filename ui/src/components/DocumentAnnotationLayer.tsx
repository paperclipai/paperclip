import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MessageSquarePlus } from "lucide-react";
import type {
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildAnchorFromContainerSelection,
  getContainerTextOffset,
  rangesForNormalizedSpan,
} from "@/lib/document-annotation-selection";
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
   * Optional override for the floating selection toolbar contents. When provided,
   * it replaces the built-in "Comment" button so callers (e.g. the document
   * detail view) can offer richer actions like "Suggest edit" while reusing the
   * layer's caret-anchored positioning. `addComment` runs the same flow the
   * default button does; `clear` drops the pending selection.
   */
  renderSelectionToolbar?: (args: {
    anchor: PendingAnchor;
    addComment: () => void;
    clear: () => void;
  }) => React.ReactNode;
}

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
}

interface ToolbarPosition {
  top: number;
  left: number;
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
  renderSelectionToolbar,
}: AnnotationLayerProps) {
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([]);
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastCaptureSelectionRequestIdRef = useRef<number>(0);
  const reactId = useId();
  const nativeHighlightInstanceId = useMemo(
    () => `document-annotation-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const nativeHighlightsSupported = getNativeHighlightApi() !== null;

  const visibleThreads = useMemo(() => {
    if (!hideResolved) return threads;
    return threads.filter((thread) => thread.status !== "resolved" || thread.anchorState === "orphaned" || thread.id === focusedThreadId);
  }, [threads, hideResolved, focusedThreadId]);

  const computeHighlightRects = useCallback(() => {
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
    for (const thread of visibleThreads) {
      if (thread.anchorState === "orphaned") continue;
      const isFocused = thread.id === focusedThreadId;
      const isStale = thread.anchorState === "stale";
      const isResolved = thread.status === "resolved";
      const nativeKind = nativeHighlightKind({
        focused: isFocused,
        stale: isStale,
        resolved: isResolved,
      });
      const ranges = rangesForNormalizedSpan({
        container,
        selectedText: thread.selectedText,
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
            threadId: thread.id,
            status: thread.status,
            anchorState: thread.anchorState,
            top: visibleRect.top - overlayRect.top,
            left: visibleRect.left - overlayRect.left,
            width: visibleRect.width,
            height: visibleRect.height,
            isTail: false,
          });
        }
        if (rangeIsVisible) nativeRanges[nativeKind].push(range);
      }
      if (next.length > startIndex) {
        next[next.length - 1].isTail = true;
      }
    }
    setNativeHighlightRanges(nativeHighlightInstanceId, nativeRanges);
    setHighlightRects(next);
  }, [containerRef, focusedThreadId, nativeHighlightInstanceId, visibleThreads]);

  useLayoutEffect(() => {
    computeHighlightRects();
  }, [computeHighlightRects]);

  useEffect(() => () => clearNativeHighlightRanges(nativeHighlightInstanceId), [nativeHighlightInstanceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    const overlay = overlayRef.current;
    let cancelled = false;
    let frame: number | null = null;

    const schedule = () => {
      if (cancelled || frame !== null) return;
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
        const onlyLayerMutations = mutations.every((mutation) => {
          const target = elementFromNode(mutation.target);
          return !!target?.closest(".paperclip-doc-annotation-layer, .paperclip-doc-annotation-visual-layer");
        });
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
  }, [computeHighlightRects, containerRef]);

  const captureSelection = useCallback((): PendingAnchor | null => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const containerOffset = getContainerTextOffset(container, range);
    if (!containerOffset) return null;
    const anchor = buildAnchorFromContainerSelection({ markdown, containerOffset });
    if (!anchor) return null;
    const overlayRect = overlay.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const top = Math.max(0, rect.top - overlayRect.top - 36);
    const left = Math.max(0, rect.left - overlayRect.left + rect.width / 2 - 80);
    setToolbarPosition({ top, left });
    return {
      selector: anchor.selector,
      selectedText: containerOffset.selectedText,
    };
  }, [containerRef, markdown]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleSelectionChange = () => {
      const anchor = captureSelection();
      if (!anchor) {
        onPendingAnchorChange(null);
        setToolbarPosition(null);
        return;
      }
      onPendingAnchorChange(anchor);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [captureSelection, onPendingAnchorChange]);

  useEffect(() => {
    if (captureSelectionRequestId === undefined) return;
    if (captureSelectionRequestId === 0) return;
    if (lastCaptureSelectionRequestIdRef.current === captureSelectionRequestId) return;
    lastCaptureSelectionRequestIdRef.current = captureSelectionRequestId;
    const anchor = captureSelection();
    if (anchor) {
      onPendingAnchorChange(anchor);
      onRequestComment(anchor);
    }
  }, [captureSelectionRequestId, captureSelection, onPendingAnchorChange, onRequestComment]);

  const handleAddComment = () => {
    if (pendingAnchor) onRequestComment(pendingAnchor);
  };

  return (
    <>
      {!nativeHighlightsSupported ? (
        <div className="paperclip-doc-annotation-visual-layer pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <div className="relative h-full w-full">
            {highlightRects.map((rect, index) => {
              const isFocused = rect.threadId === focusedThreadId;
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
                          ? "bg-yellow-300 outline outline-2 outline-offset-0 outline-yellow-700/85 shadow-[0_0_0_1px_var(--color-background)] dark:bg-yellow-500 dark:outline-yellow-200/85"
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
        className="paperclip-doc-annotation-layer pointer-events-none absolute inset-0 z-[2]"
        aria-hidden="true"
      >
        <div ref={overlayRef} className="relative h-full w-full">
          {highlightRects.map((rect, index) => {
            const isFocused = rect.threadId === focusedThreadId;
            return (
              <button
                key={`${rect.threadId}-${index}`}
                type="button"
                data-thread-id={rect.threadId}
                data-anchor-state={rect.anchorState}
                data-status={rect.status}
                data-focused={isFocused || undefined}
                aria-label="Open annotation thread"
                className={cn(
                  "paperclip-doc-annotation-hit-target pointer-events-auto absolute cursor-pointer rounded-none bg-transparent",
                  isFocused && "ring-1 ring-transparent",
                )}
                style={{
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onThreadFocus(rect.threadId);
                }}
              />
            );
          })}
          {highlightRects.map((rect, index) =>
            rect.isTail && rect.anchorState === "stale" ? (
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
              data-testid="document-annotation-selection-toolbar"
              role="toolbar"
              aria-label="Selection actions"
              className="paperclip-doc-annotation-selection-toolbar pointer-events-auto absolute z-10 flex items-center gap-1 rounded-md border border-border bg-popover px-1 py-1 shadow-md"
              style={{ top: toolbarPosition.top, left: toolbarPosition.left }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {renderSelectionToolbar ? (
                renderSelectionToolbar({
                  anchor: pendingAnchor,
                  addComment: handleAddComment,
                  clear: () => onPendingAnchorChange(null),
                })
              ) : (
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
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
