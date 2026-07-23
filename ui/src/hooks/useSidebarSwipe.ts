import { useEffect } from "react";

const EDGE_ZONE = 24; // px from left edge to start open-swipe
const MIN_DISTANCE = 60; // minimum horizontal swipe distance
const AXIS_LOCK_SLOP = 10; // px of movement before the gesture's axis is decided
const MAX_SLOPE = 0.7; // max |dy|/|dx| for the finished gesture to still count

export interface SidebarSwipeOptions {
  /** Attach listeners only when true (mobile layout). */
  enabled: boolean;
  /** Whether the sidebar is currently open. */
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Edge-swipe gesture to open/close the sidebar on mobile.
 *
 * Deliberately conservative (GH #19): the first movement past AXIS_LOCK_SLOP
 * locks the gesture's axis, so a vertical scroll that drifts sideways never
 * opens the sidebar, and a `touchcancel` — fired when the system claims the
 * touch for its own edge gesture, e.g. swipe-back navigation — discards the
 * gesture entirely.
 */
export const useSidebarSwipe = ({ enabled, isOpen, onOpenChange }: SidebarSwipeOptions) => {
  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let gesture: "idle" | "pending" | "horizontal" | "vertical" = "idle";

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        gesture = "idle";
        return;
      }
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
      gesture = "pending";
    };

    const onTouchMove = (e: TouchEvent) => {
      if (gesture !== "pending") return;
      const t = e.touches[0]!;
      const dx = Math.abs(t.clientX - startX);
      const dy = Math.abs(t.clientY - startY);
      if (Math.max(dx, dy) < AXIS_LOCK_SLOP) return;
      gesture = dx >= dy ? "horizontal" : "vertical";
    };

    const onTouchEnd = (e: TouchEvent) => {
      const wasHorizontal = gesture === "horizontal";
      gesture = "idle";
      // Never locking horizontal means a tap, a vertical scroll, or no gesture.
      if (!wasHorizontal) return;

      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy > Math.abs(dx) * MAX_SLOPE) return; // drifted diagonal overall

      // Swipe right from left edge → open
      if (!isOpen && startX <= EDGE_ZONE && dx >= MIN_DISTANCE) {
        onOpenChange(true);
        return;
      }

      // Swipe left when open → close
      if (isOpen && dx <= -MIN_DISTANCE) {
        onOpenChange(false);
      }
    };

    const onTouchCancel = () => {
      gesture = "idle";
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [enabled, isOpen, onOpenChange]);
};
