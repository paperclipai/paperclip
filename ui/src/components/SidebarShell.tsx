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
import { usePaneWidthReset } from "@/hooks/usePaneWidthReset";

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

type SidebarShellProps = {
  children: ReactNode;
  /** Whether the sidebar occupies space at all (mobile back-compat / hidden). */
  open: boolean;
  resizable?: boolean;
  storageKey?: string;
  className?: string;
};

export function SidebarShell({
  children,
  open,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
}: SidebarShellProps) {
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const { resetting, startReset, cancelReset, onResetTransitionEnd } = usePaneWidthReset();
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    cancelReset();
    const storedWidth = readStoredSidebarWidth(storageKey);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey, cancelReset]);

  useEffect(() => { cancelReset(); }, [open, cancelReset]);

  const canResize = resizable && open;
  const sidebarStyle = useMemo(() => ({ width: open ? `${width}px` : "0px" }), [open, width]);

  const commitWidth = useCallback(
    (nextWidth: number, animate = false) => {
      if (animate) startReset();
      else cancelReset();
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      writeStoredSidebarWidth(storageKey, clamped);
    },
    [storageKey, startReset, cancelReset],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canResize) return;

      event.preventDefault();
      const startWidth = resetting ? shellRef.current!.getBoundingClientRect().width : widthRef.current;
      cancelReset();
      widthRef.current = startWidth;
      setWidth(startWidth);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = { startX: event.clientX, startWidth };
      setIsResizing(true);
    },
    [canResize, resetting, cancelReset],
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
      if (!canResize) return;
      const currentWidth = resetting ? shellRef.current!.getBoundingClientRect().width : width;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(currentWidth - SIDEBAR_WIDTH_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(currentWidth + SIDEBAR_WIDTH_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(MIN_SIDEBAR_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(MAX_SIDEBAR_WIDTH);
      }
    },
    [canResize, commitWidth, width, resetting],
  );

  return (
    <div ref={shellRef} className={cn("sidebar-shell relative h-full shrink-0", className)} style={sidebarStyle}
      data-width-resetting={resetting && canResize && !isResizing || undefined} onTransitionEnd={onResetTransitionEnd}>
      <div
        className="sidebar-shell-panel absolute inset-y-0 left-0 flex flex-col overflow-hidden z-0"
        style={sidebarStyle}
      >
        {children}
      </div>
      {canResize ? (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-dragging={isResizing ? "" : undefined}
          className="pane-resize-handle group absolute inset-y-0 z-20 cursor-col-resize touch-none outline-none"
          style={{ right: -4, width: 8 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onDoubleClick={() => commitWidth(DEFAULT_SIDEBAR_WIDTH, true)}
          onKeyDown={handleKeyDown}
        >
          <div
            className={cn(
              "mx-auto h-full w-0.5 transition-colors",
              isResizing
                ? "bg-ring"
                : "bg-transparent group-hover:bg-ring group-focus-visible:bg-ring",
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
