import { useEffect, useState } from "react";
import { MobileNavScrollTracker } from "../lib/mobile-nav-scroll";

export function useMobileNavVisibility(enabled: boolean, pathname: string): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    if (!enabled) return;

    const styles = getComputedStyle(document.documentElement);
    const distance = (token: string) => Number.parseFloat(styles.getPropertyValue(token)) || 0;
    const scrollBounds = () => {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        top: window.scrollY || root.scrollTop || 0,
        max: Math.max(0, root.scrollHeight - root.clientHeight),
      };
    };
    const initial = scrollBounds();
    const tracker = new MobileNavScrollTracker({
      topZone: distance("--mobile-nav-scroll-top-zone"),
      hideDistance: distance("--mobile-nav-scroll-hide-distance"),
      showDistance: distance("--mobile-nav-scroll-show-distance"),
    }, initial.top, initial.max);
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const { top, max } = scrollBounds();
        const previous = tracker.visible;
        const next = tracker.update(top, max);
        if (next !== previous) setVisible(next);
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enabled, pathname]);

  return visible;
}
