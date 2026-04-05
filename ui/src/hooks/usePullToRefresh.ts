import { useCallback, useEffect, useRef, useState } from "react";

interface PullToRefreshOptions {
  /** Callback fired when the user completes a pull-to-refresh gesture. */
  onRefresh: () => void | Promise<void>;
  /** Minimum pull distance (px) to trigger a refresh. Default 80. */
  threshold?: number;
  /** Whether the hook is active. Default true. */
  enabled?: boolean;
}

interface PullToRefreshResult {
  /** True while the refresh callback is executing. */
  isRefreshing: boolean;
  /** Current pull distance in px (0 when not pulling). */
  pullDistance: number;
  /** Attach this ref to the scrollable container element. */
  containerRef: React.RefCallback<HTMLElement>;
}

/**
 * Detects a pull-down gesture on touch devices when the container
 * is scrolled to the top, then triggers a refetch callback.
 */
export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  enabled = true,
}: PullToRefreshOptions): PullToRefreshResult {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startYRef = useRef<number | null>(null);
  const containerElRef = useRef<HTMLElement | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const containerRef = useCallback((el: HTMLElement | null) => {
    containerElRef.current = el;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Only activate on touch devices
    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;

    const handleTouchStart = (e: TouchEvent) => {
      const el = containerElRef.current;
      // Only start tracking if scrolled to top (or no scroll container)
      const scrollTop = el ? el.scrollTop : window.scrollY;
      if (scrollTop <= 0) {
        startYRef.current = e.touches[0].clientY;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (startYRef.current === null || isRefreshing) return;
      const currentY = e.touches[0].clientY;
      const delta = currentY - startYRef.current;
      if (delta > 0) {
        // Dampen the pull distance
        setPullDistance(Math.min(delta * 0.4, threshold * 1.5));
      } else {
        // User scrolled up, cancel
        startYRef.current = null;
        setPullDistance(0);
      }
    };

    const handleTouchEnd = async () => {
      if (startYRef.current === null) return;
      startYRef.current = null;
      if (pullDistance >= threshold && !isRefreshing) {
        setIsRefreshing(true);
        setPullDistance(0);
        try {
          await onRefreshRef.current();
        } finally {
          setIsRefreshing(false);
        }
      } else {
        setPullDistance(0);
      }
    };

    const target = containerElRef.current ?? document;
    target.addEventListener("touchstart", handleTouchStart as EventListener, { passive: true });
    target.addEventListener("touchmove", handleTouchMove as EventListener, { passive: true });
    target.addEventListener("touchend", handleTouchEnd as EventListener, { passive: true });

    return () => {
      target.removeEventListener("touchstart", handleTouchStart as EventListener);
      target.removeEventListener("touchmove", handleTouchMove as EventListener);
      target.removeEventListener("touchend", handleTouchEnd as EventListener);
    };
  }, [enabled, isRefreshing, pullDistance, threshold]);

  return { isRefreshing, pullDistance, containerRef };
}
