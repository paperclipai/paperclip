import { useEffect, useRef, type RefObject } from "react";

/**
 * Tracks whether the pointer has physically moved since the last keyboard nav,
 * so hover can hand the selection back to the mouse without a keyboard-driven
 * scroll stealing it (keyboard nav scrolls the list, which fires mouseenter on
 * whatever row lands under the stationary cursor).
 *
 * Callers set the ref to `false` when they handle a nav key; it flips back to
 * `true` on the next real pointer movement.
 *
 * Prefers pointer events so a trackpad on iPadOS keeps hover and `hjkl` in sync
 * on touch-first devices: touch is ignored because a finger never hovers a row, so a scroll
 * gesture must not take the selection away from the keyboard. `mousemove` is only
 * a fallback for browsers without PointerEvent — on iOS it also fires as a
 * synthetic compatibility event on tap, which would defeat that filter.
 */
export function usePointerMovedSinceKeyNav(): RefObject<boolean> {
  const pointerMovedRef = useRef(true);

  useEffect(() => {
    const markMoved = () => {
      pointerMovedRef.current = true;
    };

    if (typeof window.PointerEvent !== "function") {
      window.addEventListener("mousemove", markMoved, { passive: true });
      return () => window.removeEventListener("mousemove", markMoved);
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      markMoved();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, []);

  return pointerMovedRef;
}
