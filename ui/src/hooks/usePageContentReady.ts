import { useLayoutEffect, useRef } from "react";
import {
  registerPageContentGate,
  setPageContentGateReady,
  unregisterPageContentGate,
} from "@/lib/browser-tracing/page-content-gates";

/**
 * Declares when this page's primary content has rendered, for the page-load
 * measurement in `doc/browser-performance-tracing.md`.
 *
 * Most pages need nothing: a navigation ends when no full-page loading state
 * is mounted and no query without data is still fetching. Call this hook only
 * when that generic rule is not accurate for a page. Once a page calls it, the
 * navigation ends when every mounted caller passes `ready`, at the first paint
 * after that.
 *
 * Pass `paintedAt` (a `performance.now()` value) when the page already records
 * its own paint time; otherwise the hook waits two animation frames so the
 * time marks a painted frame. The hook sends nothing itself and costs one map
 * entry while mounted.
 */
export function usePageContentReady(
  ready: boolean,
  paintedAt?: number | null,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const gateRef = useRef<number | null>(null);

  // `enabled: false` leaves the page on the generic rule, for a surface that
  // has no content signal in its current state.
  useLayoutEffect(() => {
    if (!enabled) return;
    const id = registerPageContentGate("content");
    gateRef.current = id;
    return () => {
      unregisterPageContentGate(id);
      gateRef.current = null;
    };
  }, [enabled]);

  useLayoutEffect(() => {
    const id = gateRef.current;
    if (id === null) return;
    if (!ready) {
      setPageContentGateReady(id, null);
      return;
    }
    if (typeof paintedAt === "number") {
      setPageContentGateReady(id, paintedAt);
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      setPageContentGateReady(id, performance.now());
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPageContentGateReady(id, performance.now()));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready, paintedAt, enabled]);
}

/**
 * Marks a full-page loading state (spinner, route Suspense fallback) as on
 * screen. A navigation cannot count as loaded while one is mounted.
 */
export function useBlockingPageGate(): void {
  useLayoutEffect(() => {
    const id = registerPageContentGate("blocking");
    return () => unregisterPageContentGate(id);
  }, []);
}
