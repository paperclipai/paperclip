import { useEffect, useLayoutEffect, useRef } from "react";

const PIN_THRESHOLD_PX = 48;

function scrollingElement(): Element | null {
  return document.scrollingElement ?? document.documentElement;
}

function windowPinned(): boolean {
  const el = scrollingElement();
  if (!el) return true;
  return el.scrollHeight - window.scrollY - window.innerHeight <= PIN_THRESHOLD_PX;
}

function scrollWindowToBottom(): void {
  const el = scrollingElement();
  if (!el) return;
  window.scrollTo({ top: el.scrollHeight, left: 0, behavior: "auto" });
}

/**
 * Window-scroll counterpart of TaskMessageScroller's auto-follow rule, for the
 * mobile document-flow thread (the mobile app shell scrolls the document, not
 * an inner viewport — see Layout.tsx). While the window is pinned to the
 * bottom (within a small threshold) content growth follows with INSTANT
 * scroll; once the user scrolls up we hold their position.
 *
 * The initial follow runs in a passive effect plus one rAF: Layout's
 * navigation scroll handling (reset-to-top on PUSH, scroll-memory re-apply on
 * POP) runs in ancestor layout effects, which fire AFTER this component's
 * layout effects in the same commit — deferring past them keeps the reset
 * from clobbering the follow.
 */
export function useWindowAutoFollow(contentKey: unknown, enabled: boolean): void {
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    const onScroll = () => {
      pinnedRef.current = windowPinned();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled]);

  // Follow new content only when already pinned; otherwise hold position.
  useLayoutEffect(() => {
    if (!enabled) return;
    if (pinnedRef.current) scrollWindowToBottom();
  }, [contentKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    scrollWindowToBottom();
    const raf = requestAnimationFrame(() => {
      scrollWindowToBottom();
      pinnedRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
    // Initial follow only — content-driven follow is the layout effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
