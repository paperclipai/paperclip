import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STEP = 16;

// Collapsed icon rail. Width is chosen so the icon is *centered* in the rail,
// which keeps the active/hover highlight symmetric around it (PAP-10676):
// the icon's left edge sits at nav px-3 (12) + item px-3 (12) = 24px, so a
// matching 24px trailing margin (12 item px-3 + 12 nav px-3) yields
// 24 + 16 (icon) + 24 = 64. The icon's left edge is unchanged from the expanded
// layout, so icons stay pixel-identical across states.
export const SIDEBAR_RAIL_WIDTH = 64;

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
  /** Pinned collapsed (rail) mode. Desktop-only; the caller gates this. */
  collapsed?: boolean;
  /** Ephemeral hover/focus peek. Only meaningful while collapsed. */
  peeking?: boolean;
  resizable?: boolean;
  storageKey?: string;
  className?: string;
  /** Forwarded to the overlay panel so Layout can wire peek triggers. */
  onPanelMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onPanelMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onPanelFocusCapture?: FocusEventHandler<HTMLDivElement>;
  onPanelBlurCapture?: FocusEventHandler<HTMLDivElement>;
};

/**
 * Layout shell for the desktop sidebar. Owns the persisted expanded width and
 * renders two layers:
 *  - an in-flow spacer that reserves `reservedWidth` (rail when collapsed,
 *    expanded width otherwise) so content to the right only reflows on pin, and
 *  - an absolutely-positioned panel of `panelWidth` (rail at rest, expanded
 *    while peeking) that overlays content — with shadow/raised z-index — when it
 *    is wider than the reserved spacer.
 *
 * The icon-alignment guarantee comes for free: collapsing is a pure width
 * change with `overflow-hidden` clipping the labels; item padding/icon markup
 * are never touched, so the left-aligned icon stays pixel-identical.
 *
 * Opening/closing is intentionally instant (no width transition): the pin toggle
 * and peek snap between rail and expanded widths so the content never appears to
 * slide. Resizing the drag handle is likewise direct.
 */
export function SidebarShell({
  children,
  open,
  collapsed = false,
  peeking = false,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
  onPanelMouseEnter,
  onPanelMouseLeave,
  onPanelFocusCapture,
  onPanelBlurCapture,
}: SidebarShellProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth(storageKey);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey]);

  // Unified width function (plan §5): one code path for every pinned state.
  const expandedWidth = open ? width : 0;
  const reservedWidth = !open ? 0 : collapsed ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const panelWidth = !open ? 0 : collapsed && !peeking ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const isOverlay = panelWidth > reservedWidth;

  // The drag handle can only resize the expanded width, so it is disabled while
  // collapsed (the rail width is a fixed constant, not user-resizable).
  const canResize = resizable && open && !collapsed;

  const reservedStyle = useMemo(
    () => ({ width: `${reservedWidth}px` }),
    [reservedWidth],
  );
  const panelStyle = useMemo(
    () => ({ width: `${panelWidth}px` }),
    [panelWidth],
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
      if (!canResize) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = { startX: event.clientX, startWidth: widthRef.current };
      setIsResizing(true);
    },
    [canResize],
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
    [canResize, commitWidth, width],
  );

  return (
    <div className={cn("relative h-full shrink-0", className)} style={reservedStyle}>
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col overflow-hidden",
          // Open/close is instant (PAP-10676): no width transition so the rail and
          // expanded states snap without any sliding motion.
          // Overlay styling only while the panel is wider than its reserved
          // spacer (i.e. peeking) so it floats above content without reflow.
          isOverlay
            ? "z-30 border-r border-border bg-background shadow-lg"
            : "z-0",
        )}
        style={panelStyle}
        data-sidebar-overlay={isOverlay ? "" : undefined}
        onMouseEnter={onPanelMouseEnter}
        onMouseLeave={onPanelMouseLeave}
        onFocusCapture={onPanelFocusCapture}
        onBlurCapture={onPanelBlurCapture}
      >
        {children}
        {canResize ? (
          <div
            role="separator"
            aria-label={t("components.sidebarShell.resizeSidebar", {
              defaultValue: "Resize sidebar",
            })}
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
    </div>
  );
}
