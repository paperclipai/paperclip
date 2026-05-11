import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STEP = 16;

function clampSidebarWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, width));
}

function readStoredSidebarWidth(storageKey: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return fallback;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clampSidebarWidth(parsed, min, max);
  } catch {
    return fallback;
  }
}

function writeStoredSidebarWidth(storageKey: string, width: number, min: number, max: number) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, String(clampSidebarWidth(width, min, max)));
  } catch {
    // Storage can be unavailable in private contexts; resizing should still work.
  }
}

type ResizableSidebarPaneProps = {
  children: ReactNode;
  open: boolean;
  resizable?: boolean;
  storageKey?: string;
  className?: string;
  /** Which side of the viewport this pane sits on. Determines handle position and drag direction. */
  side?: "left" | "right";
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Below this viewport width, clamp the pane to compactMaxWidth. */
  compactBelowViewport?: number;
  compactMaxWidth?: number;
  /** Optional CSS custom property name to expose the live pane width on :root (e.g. "--properties-panel-width"). */
  widthVariable?: string;
};

function readViewportWidth() {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  return window.innerWidth;
}

export function ResizableSidebarPane({
  children,
  open,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
  side = "left",
  defaultWidth = DEFAULT_SIDEBAR_WIDTH,
  minWidth = MIN_SIDEBAR_WIDTH,
  maxWidth = MAX_SIDEBAR_WIDTH,
  compactBelowViewport,
  compactMaxWidth,
  widthVariable,
}: ResizableSidebarPaneProps) {
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  const compactModeActive =
    compactBelowViewport !== undefined
    && compactMaxWidth !== undefined
    && viewportWidth < compactBelowViewport;
  const effectiveMaxWidth =
    compactModeActive
      ? Math.max(minWidth, Math.min(maxWidth, compactMaxWidth))
      : maxWidth;
  const canResizeAtCurrentViewport = effectiveMaxWidth > minWidth;
  const fallbackWidth = clampSidebarWidth(defaultWidth, minWidth, effectiveMaxWidth);
  const [width, setWidth] = useState(() =>
    readStoredSidebarWidth(storageKey, fallbackWidth, minWidth, effectiveMaxWidth),
  );
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth(storageKey, fallbackWidth, minWidth, effectiveMaxWidth);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey, fallbackWidth, minWidth, effectiveMaxWidth]);

  const visibleWidth = open ? width : 0;
  const paneStyle = useMemo(
    () => ({ width: `${visibleWidth}px` }),
    [visibleWidth],
  );

  useEffect(() => {
    if (!widthVariable || typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty(widthVariable, `${visibleWidth}px`);
    return () => {
      root.style.removeProperty(widthVariable);
    };
  }, [widthVariable, visibleWidth]);

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampSidebarWidth(nextWidth, minWidth, effectiveMaxWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      if (!compactModeActive) {
        writeStoredSidebarWidth(storageKey, clamped, minWidth, maxWidth);
      }
    },
    [storageKey, minWidth, maxWidth, effectiveMaxWidth, compactModeActive],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!open || !resizable) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = { startX: event.clientX, startWidth: widthRef.current };
      setIsResizing(true);
    },
    [open, resizable],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;

      const delta = event.clientX - dragState.current.startX;
      // For a right-side pane the handle is on the left edge, so dragging left increases width.
      const directional = side === "right" ? -delta : delta;
      const nextWidth = dragState.current.startWidth + directional;
      const clamped = clampSidebarWidth(nextWidth, minWidth, effectiveMaxWidth);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [side, minWidth, effectiveMaxWidth],
  );

  const endResize = useCallback(() => {
    if (!dragState.current) return;

    dragState.current = null;
    setIsResizing(false);
    if (!compactModeActive) {
      writeStoredSidebarWidth(storageKey, widthRef.current, minWidth, maxWidth);
    }
  }, [storageKey, minWidth, maxWidth, compactModeActive]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!open || !resizable || !canResizeAtCurrentViewport) return;

      // Match drag semantics: on a right-side pane, ArrowLeft grows the pane.
      const growKey = side === "right" ? "ArrowLeft" : "ArrowRight";
      const shrinkKey = side === "right" ? "ArrowRight" : "ArrowLeft";

      if (event.key === growKey) {
        event.preventDefault();
        commitWidth(width + SIDEBAR_WIDTH_STEP);
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        commitWidth(width - SIDEBAR_WIDTH_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(minWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(effectiveMaxWidth);
      }
    },
    [commitWidth, open, resizable, side, width, minWidth, effectiveMaxWidth, canResizeAtCurrentViewport],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        !isResizing && "transition-[width] duration-100 ease-out",
        className,
      )}
      style={paneStyle}
    >
      {children}
      {resizable && open && canResizeAtCurrentViewport ? (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={effectiveMaxWidth}
          aria-valuenow={width}
          tabIndex={0}
          className={cn(
            "absolute inset-y-0 z-20 w-3 cursor-col-resize touch-none outline-none",
            side === "right" ? "left-0" : "right-0",
            "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors",
            "hover:before:bg-border focus-visible:before:bg-ring",
            isResizing && "before:bg-ring",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onKeyDown={handleKeyDown}
        />
      ) : null}
    </div>
  );
}
