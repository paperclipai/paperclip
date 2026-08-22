import { useEffect, useRef } from "react";

/**
 * Keeps a scroll container pinned to the bottom as its content grows (e.g. a
 * streaming run transcript), unless the user has scrolled up — in which case it
 * stops auto-scrolling until they return near the bottom.
 *
 * Usage:
 *   const { ref, onScroll } = useAutoScroll<HTMLDivElement>();
 *   <div ref={ref} onScroll={onScroll} className="overflow-y-auto">…</div>
 */
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  // Whether to keep the view pinned to the bottom. A ref (not state) so
  // scroll-handling never triggers a re-render.
  const stick = useRef(true);

  // Runs after every render, i.e. whenever streamed content changes the DOM.
  // Assigning scrollTop does not itself cause a React re-render, so this is safe
  // without a dependency array.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    // Re-engage sticking only when the user is at (or near) the bottom, so
    // scrolling up to read history pauses auto-scroll.
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return { ref, onScroll };
}
