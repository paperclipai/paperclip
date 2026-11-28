import { useLayoutEffect, useRef, type RefObject } from "react";

/** Long enough for rows that load just after the page to join its entry. */
const PAGE_ENTER_WINDOW_MS = 1200;

/** Marks `ref` with `data-page-enter` while a new page enters. Styled in interaction-motion.css. */
export function usePageEnterMotion(ref: RefObject<HTMLElement | null>, pageKey: string) {
  const previousKey = useRef(pageKey);

  useLayoutEffect(() => {
    if (previousKey.current === pageKey) return;
    previousKey.current = pageKey;
    const element = ref.current;
    if (!element) return;
    element.removeAttribute("data-page-enter");
    // Reading layout restarts the animation when one page replaces another mid-entry.
    void element.offsetWidth;
    element.setAttribute("data-page-enter", "");
    const timer = window.setTimeout(() => element.removeAttribute("data-page-enter"), PAGE_ENTER_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [pageKey, ref]);
}
