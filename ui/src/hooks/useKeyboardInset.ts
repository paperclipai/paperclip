import { useEffect, useState } from "react";

/**
 * iOS Safari does not shrink the layout viewport when the software keyboard
 * opens: window.innerHeight, 100vh and 100dvh all keep their full value, and
 * only window.visualViewport reports the smaller visible area. Anything docked
 * to the bottom of the page - the fixed mobile nav, the sticky task composer -
 * therefore ends up behind the keyboard. Chrome on Android can be told to
 * shrink the layout viewport with `interactive-widget=resizes-content`, but
 * Safari ignores that flag, so the UI has to measure the keyboard itself.
 *
 * This hook measures the occluded strip at the bottom of the layout viewport
 * and publishes it as --sz-keyboard-inset on <html>, so plain CSS can lift
 * docked chrome clear of the keyboard. It returns the inset in px so callers
 * can also branch in JS (e.g. hide the bottom nav while typing).
 */

const KEYBOARD_INSET_VAR = "--sz-keyboard-inset";

// Safari's collapsing bottom toolbar also shrinks the visual viewport, by
// roughly 50px. Only treat a large inset as a keyboard.
const MIN_KEYBOARD_INSET = 120;

// A few px of rounding slack, so a valid reading is never rejected for being
// a fraction of a pixel taller than the layout viewport.
const VIEWPORT_GEOMETRY_SLACK = 2;

/**
 * Returns the keyboard inset in px, or null when the visual viewport reports
 * geometry that cannot be trusted. Mobile browsers briefly publish unusable
 * values while they resize or rotate - a zero height, a negative offset - and
 * subtracting those gives an inset the size of the whole window, which throws
 * the composer off-screen. Callers keep their last valid inset on null, the
 * same way NewIssueDialog handles readVisualViewportLayout.
 */
function readKeyboardInset(): number | null {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  const { height, offsetTop, scale } = viewport;
  const windowHeight = window.innerHeight;
  if (
    !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(offsetTop)
    || offsetTop < 0
    || !Number.isFinite(scale)
    || scale <= 0
    || !Number.isFinite(windowHeight)
    || windowHeight <= 0
    // The visible area cannot be taller than the layout viewport it sits in.
    || height + offsetTop > windowHeight + VIEWPORT_GEOMETRY_SLACK
  ) {
    return null;
  }
  // Pinch-zoom shrinks the visual viewport too. That is not a keyboard.
  if (Math.abs(scale - 1) > 0.01) return 0;
  const inset = windowHeight - (height + offsetTop);
  return inset >= MIN_KEYBOARD_INSET ? Math.round(inset) : 0;
}

export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(() => (enabled ? readKeyboardInset() ?? 0 : 0));

  useEffect(() => {
    if (!enabled) {
      setInset(0);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readKeyboardInset();
        // Hold the last valid inset through a transient bad reading.
        if (next === null) return;
        setInset(next);
      });
    };

    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);

    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, [enabled]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
    root.classList.toggle("keyboard-open", inset > 0);
    return () => {
      root.style.removeProperty(KEYBOARD_INSET_VAR);
      root.classList.remove("keyboard-open");
    };
  }, [inset]);

  return inset;
}
