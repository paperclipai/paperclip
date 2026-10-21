import { useCallback, useEffect, useRef, useState, type TransitionEvent } from "react";

/** Enables width transitions only for an explicit reset, never for dragging. */
export function usePaneWidthReset() {
  const [resetting, setResetting] = useState(false);
  const timer = useRef<number | null>(null);
  const cancelReset = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setResetting(false);
  }, []);
  const startReset = useCallback(() => {
    cancelReset();
    const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-pane-width-reset").trim();
    const duration = Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
    if (!Number.isFinite(duration) || duration <= 0) return;
    setResetting(true);
    // Covers a no-op reset or a transition that is canceled without an end event.
    timer.current = window.setTimeout(cancelReset, duration * 2);
  }, [cancelReset]);
  const onResetTransitionEnd = useCallback((event: TransitionEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && (event.propertyName === "width" || event.propertyName === "flex-basis")) {
      cancelReset();
    }
  }, [cancelReset]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return { resetting, startReset, cancelReset, onResetTransitionEnd };
}
