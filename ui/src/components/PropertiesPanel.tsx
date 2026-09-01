import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useClassicTaskInterfaceEnabled } from "../hooks/useClassicTaskInterfaceEnabled";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidePanelFrame, SidePanelWindowControls } from "@/components/side-panel";

export function PropertiesPanel() {
  const { panelContent, panelContentMode, panelVisible, setPanelVisible } = usePanel();
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
            <div className="p-4">{panelContent}</div>
          </ScrollArea>
        </div>
      </aside>
    );
  }

  return (
    <ResizablePropertiesPanel
      panelContent={panelContent}
      panelContentMode={panelContentMode}
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
  panelContentMode: "padded" | "prose" | "full-bleed";
  panelVisible: boolean;
  setPanelVisible: (visible: boolean) => void;
}

function ResizablePropertiesPanel({
  panelContent,
  panelContentMode,
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
          <SidePanelFrame
            presentation="docked"
            maximized={maximized}
            contentMode="full-bleed"
            className="flex-1 border-l-0"
            header={(
              <div
                id={PROPERTIES_PANE_HEADER_SLOT_ID}
                className="flex min-w-0 flex-1 items-center self-stretch"
              />
            )}
            trailingControls={(
              <SidePanelWindowControls
                maximized={maximized}
                onMaximizedChange={(next) => {
                  if (next) handleMaximize();
                  else handleRestore();
                }}
                onToggle={() => setPanelVisible(false)}
              />
            )}
            footer={<div id={PROPERTIES_PANE_FOOTER_SLOT_ID} />}
          >
            {panelContentMode === "full-bleed" ? panelContent : (
              <ScrollArea className="h-full">
                <div
                  className={cn("p-4", maximized && "mx-auto w-full px-9")}
                  style={maximized ? { maxWidth: MAXIMIZED_CONTENT_MAX_WIDTH } : undefined}
                >
                  {panelContent}
                </div>
              </ScrollArea>
            )}
          </SidePanelFrame>
        </div>
      </aside>
    </>
  );
}
