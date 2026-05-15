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

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth(storageKey: string) {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(parsed);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function writeStoredSidebarWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, String(clampSidebarWidth(width)));
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
};

export function ResizableSidebarPane({
  children,
  open,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
}: ResizableSidebarPaneProps) {
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth(storageKey);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey]);

  const visibleWidth = open ? width : 0;
  const paneStyle = useMemo(
    () => ({ width: `${visibleWidth}px` }),
    [visibleWidth],
  );

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      writeStoredSidebarWidth(storageKey, clamped);
    },
    [storageKey],
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

      const nextWidth = dragState.current.startWidth + event.clientX - dragState.current.startX;
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [],
  );

  const endResize = useCallback(() => {
    if (!dragState.current) return;

    dragState.current = null;
    setIsResizing(false);
    writeStoredSidebarWidth(storageKey, widthRef.current);
  }, [storageKey]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!open || !resizable) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(width - SIDEBAR_WIDTH_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(width + SIDEBAR_WIDTH_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(MIN_SIDEBAR_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(MAX_SIDEBAR_WIDTH);
      }
    },
    [commitWidth, open, resizable, width],
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
      {resizable && open ? (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          className={cn(
            "absolute inset-y-0 right-0 z-20 w-3 cursor-col-resize touch-none outline-none",
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
