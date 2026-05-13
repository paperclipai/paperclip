import { type PointerEvent, useEffect, useRef, useState } from "react";
import { X, ChevronDown, GripHorizontal } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "../lib/utils";

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
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={() => setPanelVisible(false)}
        />
      )}

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={cn(
          // Position: sticks to bottom, fills width
          "fixed bottom-0 left-0 right-0 z-50 lg:hidden",
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
          <div className="p-4">{panelContent}</div>
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

  if (!panelContent) return null;

  return (
    <aside
      className="hidden lg:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out h-full"
      style={{ width: panelVisible ? 320 : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div className="w-80 flex-1 flex flex-col min-w-[320px] min-h-0">
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

// ------------------------------------------------------------------
// Public export — renders both variants.
// CSS (lg:hidden / hidden lg:flex) gates which is actually visible.
// MobilePropertiesSheet: shown on phone+tablet (<lg)
// DesktopPropertiesPane: shown on desktop (≥lg)
// ------------------------------------------------------------------
export function PropertiesPanel() {
  return (
    <>
      <MobilePropertiesSheet />
      <DesktopPropertiesPane />
    </>
  );
}
