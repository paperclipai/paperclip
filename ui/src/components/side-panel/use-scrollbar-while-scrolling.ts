import { useCallback, useEffect, useRef, type UIEventHandler } from "react";

const DEFAULT_IDLE_DELAY_MS = 600;

function parseCssTimeMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return trimmed.endsWith("s") && !trimmed.endsWith("ms") ? parsed * 1000 : parsed;
}

/** Marks a scroll viewport active only while scroll events are arriving. */
export function useScrollbarWhileScrolling(): UIEventHandler<HTMLDivElement> {
  const idleTimerRef = useRef<number | null>(null);
  const activeElementRef = useRef<HTMLDivElement | null>(null);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const element = event.currentTarget;
    activeElementRef.current = element;
    element.dataset.scrollActive = "true";
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);

    const configuredDelay = parseCssTimeMs(
      getComputedStyle(document.documentElement).getPropertyValue("--motion-scrollbar-idle-delay"),
    );
    idleTimerRef.current = window.setTimeout(() => {
      delete element.dataset.scrollActive;
      idleTimerRef.current = null;
    }, configuredDelay ?? DEFAULT_IDLE_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    if (activeElementRef.current) delete activeElementRef.current.dataset.scrollActive;
  }, []);

  return handleScroll;
}
