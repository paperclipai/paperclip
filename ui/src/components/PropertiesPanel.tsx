import { createContext, useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronDown, GripHorizontal, Maximize2, Minimize2, X } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useClassicTaskInterfaceEnabled } from "../hooks/useClassicTaskInterfaceEnabled";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export type PropertiesPanelHost = "mobile" | "desktop";

/**
 * The responsive panel renders both hosts and relies on CSS to show the
 * appropriate one. Content that has host-specific layout (such as the task
 * properties tab strip) needs to know which host it is rendering in so a
 * hidden mobile copy cannot portal into the visible desktop header.
 */
export const PropertiesPanelHostContext = createContext<PropertiesPanelHost | null>(null);

// ------------------------------------------------------------------
// Mobile bottom-sheet heights (as percentages of viewport height)
// ------------------------------------------------------------------
const SHEET_PEEK = 0.12; // 12% — collapsed: shows only the handle + title
const SHEET_HALF = 0.52; // 52% — half-expanded (default on open)
const SHEET_FULL = 0.92; // 92% — fully expanded

type SheetSnap = "peek" | "half" | "full";

function snapToHeight(snap: SheetSnap, vh: number): number {
  switch (snap) {
    case "peek": return Math.round(vh * SHEET_PEEK);
    case "half": return Math.round(vh * SHEET_HALF);
    case "full": return Math.round(vh * SHEET_FULL);
  }
}

function nearestSnap(y: number, vh: number): SheetSnap {
  const snaps: SheetSnap[] = ["peek", "half", "full"];
  let best: SheetSnap = "half";
  let bestDist = Infinity;
  for (const s of snaps) {
    const dist = Math.abs(y - snapToHeight(s, vh));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Mobile bottom-sheet variant
// ------------------------------------------------------------------
function MobilePropertiesSheet() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();
  const [snap, setSnap] = useState<SheetSnap>("half");
  const [dragging, setDragging] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const startY = useRef(0);
  const startHeight = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Reset to half when panel opens
  useEffect(() => {
    if (panelVisible) setSnap("half");
  }, [panelVisible]);

  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const targetHeight = dragHeight ?? snapToHeight(snap, vh);

  // Pointer-based drag on the handle bar
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    startHeight.current = snapToHeight(snap, vh);
    setDragging(true);
    setDragHeight(startHeight.current);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const delta = startY.current - e.clientY; // drag up = positive
    const next = Math.min(snapToHeight("full", vh), Math.max(snapToHeight("peek", vh), startHeight.current + delta));
    setDragHeight(next);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    const delta = startY.current - e.clientY;
    const current = startHeight.current + delta;
    const next = nearestSnap(current, vh);
    if (next === "peek") {
      // Dismiss if released at peek
      setPanelVisible(false);
      setDragHeight(null);
      setSnap("half");
      return;
    }
    setSnap(next);
    setDragHeight(null);
  };

  if (!panelContent) return null;

  return (
    <>
      {/* Backdrop — tap to dismiss */}
      {panelVisible && (
        <button
          type="button"
          aria-label="Close properties panel"
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setPanelVisible(false)}
        />
      )}

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={cn(
          // Position: sticks to bottom, fills width
          "fixed bottom-0 left-0 right-0 z-50 md:hidden",
          // Glass surface
          "glass-surface border-t border-border/60",
          // Rounded top corners
          "rounded-t-2xl",
          // Safe-area bottom padding (sheet sits above home indicator)
          "pb-safe",
          // Transition when snapping (not during active drag)
          !dragging && "transition-[height,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          // Hidden state
          !panelVisible && "translate-y-full",
        )}
        style={{ height: panelVisible ? targetHeight : undefined }}
      >
        {/* Drag handle */}
        <div
          className="flex items-center justify-center w-full pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <GripHorizontal className="h-5 w-5 text-muted-foreground/50" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/60">
          <span className="text-sm font-medium">Properties</span>
          <div className="flex items-center gap-1">
            {snap !== "full" && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSnap("full")}
                aria-label="Expand properties"
              >
                <ChevronDown className="h-4 w-4 rotate-180" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setPanelVisible(false)}
              aria-label="Close properties"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 overflow-hidden" style={{ height: "calc(100% - 80px)" }}>
          <div className="p-4">
            <PropertiesPanelHostContext.Provider value="mobile">
              {panelContent}
            </PropertiesPanelHostContext.Provider>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

// ------------------------------------------------------------------
// Desktop side-pane variant (unchanged behavior)
// ------------------------------------------------------------------
function DesktopPropertiesPane() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();
  const { enabled: classicTaskInterfaceEnabled } = useClassicTaskInterfaceEnabled();

  if (!panelContent) return null;

  if (classicTaskInterfaceEnabled) {
    return (
      <aside
        className="hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-(--tp-width-opacity) duration-200 ease-in-out h-full"
        style={{ width: panelVisible ? 320 : 0, opacity: panelVisible ? 1 : 0 }}
      >
        <div className="w-80 flex-1 flex flex-col min-w-(--sz-320px) min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <span className="text-sm font-medium">Properties</span>
            <Button variant="ghost" size="icon-xs" onClick={() => setPanelVisible(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-4">
              <PropertiesPanelHostContext.Provider value="desktop">
                {panelContent}
              </PropertiesPanelHostContext.Provider>
            </div>
          </ScrollArea>
        </div>
      </aside>
    );
  }

  return (
    <ResizablePropertiesPanel
      panelContent={panelContent}
      panelVisible={panelVisible}
      setPanelVisible={setPanelVisible}
    />
  );
}

/* ------------------------------------------------------------------------- *
 * Chat-style (default) resizable/maximizable variant. Everything below
 * renders only when the Classic Task Interface flag is OFF.
 * ------------------------------------------------------------------------- */

/**
 * Portal target in the redesigned pane's header bar: hosted content (the
 * Properties | Plan | Artifacts tab strip) renders here, left of the window
 * controls. See IssueProperties' flag-ON shell.
 */
export const PROPERTIES_PANE_HEADER_SLOT_ID = "properties-pane-header-slot";
/**
 * Portal target pinned below the pane's scroll area: hosted content (the plan
 * confirmation action bar) renders here so it stays visible while the pane
 * body scrolls.
 */
export const PROPERTIES_PANE_FOOTER_SLOT_ID = "properties-pane-footer-slot";

const WIDTH_STORAGE_KEY = "taskChatRedesign.propertiesPaneWidth";
const DEFAULT_PANE_WIDTH = 322;
const MIN_PANE_WIDTH = 260;
/** ~236px sidebar + ~420px minimum center column stay usable while resizing. */
const RESERVED_LAYOUT_WIDTH = 656;
/** Content cap while maximized so text doesn't span the full viewport. */
const MAXIMIZED_CONTENT_MAX_WIDTH = 840;
/**
 * Defensive fallback (in milliseconds) for the restore glide in case
 * `transitionend` never fires; slightly longer than the --motion-pane-glide
 * token in index.css.
 */
const RESTORE_FALLBACK_DELAY = 400;

function clampPaneWidth(width: number): number {
  const max =
    typeof window === "undefined"
      ? Number.POSITIVE_INFINITY
      : Math.max(MIN_PANE_WIDTH, window.innerWidth - RESERVED_LAYOUT_WIDTH);
  return Math.min(Math.max(Math.round(width), MIN_PANE_WIDTH), max);
}

function readStoredPaneWidth(): number {
  if (typeof window === "undefined") return DEFAULT_PANE_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_PANE_WIDTH;
  } catch {
    return DEFAULT_PANE_WIDTH;
  }
}

function persistPaneWidth(width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage failures.
  }
}

function clearStoredPaneWidth() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(WIDTH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fixed-position geometry while the panel is maximized (or gliding). */
interface FixedPane {
  top: number;
  /** Animated by the .tc-pane-glide transition. */
  left: number;
  /** Distance from the viewport's right edge to the panel's right edge. */
  rightInset: number;
  /** Glide target: the layout row's left edge (flush with the sidebar). */
  parentLeft: number;
}

interface ResizablePropertiesPanelProps {
  panelContent: ReactNode;
  panelVisible: boolean;
  setPanelVisible: (visible: boolean) => void;
}

function ResizablePropertiesPanel({
  panelContent,
  panelVisible,
  setPanelVisible,
}: ResizablePropertiesPanelProps) {
  const [width, setWidth] = useState(() => clampPaneWidth(readStoredPaneWidth()));
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fixedPane, setFixedPane] = useState<FixedPane | null>(null);

  const asideRef = useRef<HTMLElement | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );
  const previousBodyUserSelectRef = useRef("");
  const restoreTimerRef = useRef<number | null>(null);

  const clearRestoreTimer = useCallback(() => {
    if (restoreTimerRef.current !== null) {
      window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
  }, []);

  const finishRestore = useCallback(() => {
    clearRestoreTimer();
    setFixedPane(null);
  }, [clearRestoreTimer]);

  // Hiding the panel keeps today's collapse-to-0 behavior; if it was
  // maximized (or mid-glide), just unmaximize instantly first.
  useEffect(() => {
    if (!panelVisible) {
      setMaximized(false);
      finishRestore();
    }
  }, [panelVisible, finishRestore]);

  useEffect(
    () => () => {
      if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current);
      if (dragStateRef.current !== null) {
        document.body.style.userSelect = previousBodyUserSelectRef.current;
      }
    },
    [],
  );

  const endDrag = useCallback((persist: boolean) => {
    if (dragStateRef.current === null) return;
    dragStateRef.current = null;
    setDragging(false);
    document.body.style.userSelect = previousBodyUserSelectRef.current;
    if (persist) persistPaneWidth(widthRef.current);
  }, []);

  const handleGripPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only (touch/pen report button 0 or -1 for down events).
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
    };
    previousBodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setDragging(true);
  }, []);

  const handleGripPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // The grip sits on the panel's LEFT border: moving left widens the panel.
    setWidth(clampPaneWidth(drag.startWidth + (drag.startX - event.clientX)));
  }, []);

  const handleGripPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      endDrag(true);
    },
    [endDrag],
  );

  const handleGripLostPointerCapture = useCallback(() => {
    endDrag(true);
  }, [endDrag]);

  const handleGripDoubleClick = useCallback(() => {
    setWidth(DEFAULT_PANE_WIDTH);
    clearStoredPaneWidth();
  }, []);

  const handleMaximize = useCallback(() => {
    const aside = asideRef.current;
    const row = aside?.parentElement;
    if (!aside || !row) return;
    clearRestoreTimer();
    setMaximized(true);
    const rowRect = row.getBoundingClientRect();
    setFixedPane((pane) => {
      // Re-maximizing mid-restore: keep the current geometry, glide back left.
      if (pane) return { ...pane, left: pane.parentLeft };
      const rect = aside.getBoundingClientRect();
      const seeded: FixedPane = {
        top: rect.top,
        left: rect.left,
        rightInset: Math.max(0, window.innerWidth - rect.right),
        parentLeft: rowRect.left,
      };
      if (prefersReducedMotion()) return { ...seeded, left: seeded.parentLeft };
      // Seed at the current left, then glide to the row's left edge once the
      // fixed position has been committed (double rAF).
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setFixedPane((current) => (current ? { ...current, left: current.parentLeft } : current));
        });
      });
      return seeded;
    });
  }, [clearRestoreTimer]);

  const handleRestore = useCallback(() => {
    const row = asideRef.current?.parentElement;
    setMaximized(false);
    if (prefersReducedMotion()) {
      finishRestore();
      return;
    }
    setFixedPane((pane) => {
      if (!pane) return pane;
      const rowRight = row
        ? row.getBoundingClientRect().right
        : window.innerWidth - pane.rightInset;
      return { ...pane, left: rowRight - widthRef.current };
    });
    clearRestoreTimer();
    restoreTimerRef.current = window.setTimeout(finishRestore, RESTORE_FALLBACK_DELAY);
  }, [clearRestoreTimer, finishRestore]);

  const handleTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLElement>) => {
      if (event.target !== asideRef.current || event.propertyName !== "left") return;
      // Only the restore glide needs to unfix on arrival.
      if (!maximized) finishRestore();
    },
    [maximized, finishRestore],
  );

  const isFixed = fixedPane !== null;

  return (
    <>
      {isFixed ? (
        // Holds the panel's slot in the layout flex row while the panel is
        // position:fixed, so the main column never reflows.
        <div
          aria-hidden
          className="hidden md:block shrink-0"
          style={{ width: panelVisible ? width : 0 }}
        />
      ) : null}
      <aside
        ref={asideRef}
        className={cn(
          "hidden md:flex border-l border-border bg-card flex-col",
          isFixed
            ? "tc-pane-glide fixed z-40 overflow-hidden"
            : cn(
                "relative h-full shrink-0",
                panelVisible ? "overflow-visible" : "overflow-hidden",
                // The width/opacity transition would fight pointer-driven
                // resizing, so it is suspended while dragging.
                !dragging && "transition-(--tp-width-opacity) duration-200 ease-in-out",
              ),
        )}
        style={
          isFixed
            ? {
                top: fixedPane.top,
                bottom: 0,
                left: fixedPane.left,
                right: fixedPane.rightInset,
              }
            : { width: panelVisible ? width : 0, opacity: panelVisible ? 1 : 0 }
        }
        onTransitionEnd={handleTransitionEnd}
      >
        {!isFixed && panelVisible ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            data-dragging={dragging ? "" : undefined}
            className="group absolute inset-y-0 z-10 cursor-col-resize touch-none"
            style={{ left: -4, width: 8 }}
            onPointerDown={handleGripPointerDown}
            onPointerMove={handleGripPointerMove}
            onPointerUp={handleGripPointerUp}
            onPointerCancel={handleGripPointerUp}
            onLostPointerCapture={handleGripLostPointerCapture}
            onDoubleClick={handleGripDoubleClick}
          >
            <div
              className={cn(
                "mx-auto h-full w-0.5 transition-colors",
                dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring",
              )}
            />
          </div>
        ) : null}
        <div
          className={cn("flex-1 flex flex-col min-h-0", isFixed && "w-full")}
          style={isFixed ? undefined : { width, minWidth: width }}
        >
          {/* The slot hosts whatever IssueProperties portals in — the tab strip
              when Plan/Artifacts have content, else a plain "Properties" title;
              window controls sit right. Vertical padding lives on the controls
              cluster, not the bar, so the tab strip can stretch to the border
              and its active underline hugs the header's bottom line. */}
          <div className="flex items-center justify-between gap-2 px-4 border-b border-border">
            <div
              id={PROPERTIES_PANE_HEADER_SLOT_ID}
              className="flex min-w-0 flex-1 items-center self-stretch"
            />
            <div className="flex items-center gap-1 py-2">
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                title={maximized ? "Restore panel" : "Maximize panel"}
                aria-label={maximized ? "Restore panel" : "Maximize panel"}
                onClick={maximized ? handleRestore : handleMaximize}
              >
                {maximized ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={() => setPanelVisible(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div
              className={cn("p-4", maximized && "mx-auto w-full px-9")}
              style={maximized ? { maxWidth: MAXIMIZED_CONTENT_MAX_WIDTH } : undefined}
            >
              <PropertiesPanelHostContext.Provider value="desktop">
                {panelContent}
              </PropertiesPanelHostContext.Provider>
            </div>
          </ScrollArea>
          <div id={PROPERTIES_PANE_FOOTER_SLOT_ID} className="shrink-0" />
        </div>
      </aside>
    </>
  );
}

// ------------------------------------------------------------------
// Public export — renders both variants.
// CSS (md:hidden / hidden md:flex) gates which is actually visible. This must
// stay aligned with SidebarContext's 768px mobile breakpoint so the sheet and
// desktop pane can never render at the same viewport width.
// MobilePropertiesSheet: shown below md
// DesktopPropertiesPane: shown at md and above
// ------------------------------------------------------------------
export function PropertiesPanel() {
  return (
    <>
      <MobilePropertiesSheet />
      <DesktopPropertiesPane />
    </>
  );
}
