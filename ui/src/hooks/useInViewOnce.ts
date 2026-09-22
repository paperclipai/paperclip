import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared per-document `IntersectionObserver` used to answer "has this element
 * ever been on screen?". One observer for every consumer keeps a page with
 * thousands of gated elements to a single observer instead of one each.
 */
const INTERSECTION_ROOT_MARGIN = "200px";

type IntersectHandler = () => void;

let sharedObserver: IntersectionObserver | null = null;
const handlers = new WeakMap<Element, IntersectHandler>();

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== "function") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const handler = handlers.get(entry.target);
          // First intersection is the only one that matters: stop observing so
          // scrolling past a resolved element costs nothing.
          sharedObserver?.unobserve(entry.target);
          handlers.delete(entry.target);
          handler?.();
        }
      },
      { rootMargin: INTERSECTION_ROOT_MARGIN },
    );
  }
  return sharedObserver;
}

/**
 * Returns a callback ref and a latch that flips to `true` the first time the
 * referenced element enters the viewport (plus a 200px margin), and never
 * flips back. Environments without `IntersectionObserver` (SSR, jsdom without
 * a polyfill) report `true` immediately, so gating on it can only ever defer
 * work, never drop it.
 */
export function useInViewOnce(): { ref: (node: Element | null) => void; inView: boolean } {
  const [inView, setInView] = useState(() => typeof IntersectionObserver !== "function");
  const observedRef = useRef<Element | null>(null);
  const inViewRef = useRef(inView);
  inViewRef.current = inView;

  const ref = useCallback((node: Element | null) => {
    const previous = observedRef.current;
    if (previous && previous !== node) {
      sharedObserver?.unobserve(previous);
      handlers.delete(previous);
    }
    observedRef.current = node;
    if (!node || inViewRef.current) return;

    const observer = getSharedObserver();
    if (!observer) {
      setInView(true);
      return;
    }
    handlers.set(node, () => setInView(true));
    observer.observe(node);
  }, []);

  useEffect(() => () => {
    const node = observedRef.current;
    if (!node) return;
    sharedObserver?.unobserve(node);
    handlers.delete(node);
  }, []);

  return { ref, inView };
}
