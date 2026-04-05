import { useEffect, useRef, useState } from "react";
import { useLocation } from "@/lib/router";

/**
 * Thin progress bar at the very top of the page (GitHub/YouTube style)
 * that animates during route transitions.
 *
 * Since the app uses BrowserRouter (not a data router), we detect route
 * changes via useLocation and run a quick trickle animation.
 */
export function RouteProgressBar() {
  const location = useLocation();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPathRef = useRef(location.pathname + location.search);

  useEffect(() => {
    const currentPath = location.pathname + location.search;
    if (currentPath === prevPathRef.current) return;
    prevPathRef.current = currentPath;

    // Clear any running timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (trickleRef.current) clearInterval(trickleRef.current);

    // Start the bar
    setProgress(15);
    setVisible(true);

    // Trickle up
    let current = 15;
    trickleRef.current = setInterval(() => {
      current += Math.random() * 12 + 3;
      if (current >= 90) {
        current = 90;
        if (trickleRef.current) clearInterval(trickleRef.current);
      }
      setProgress(current);
    }, 80);

    // Complete after a short delay (simulating load)
    timerRef.current = setTimeout(() => {
      if (trickleRef.current) clearInterval(trickleRef.current);
      setProgress(100);
      timerRef.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 200);
    }, 250);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (trickleRef.current) clearInterval(trickleRef.current);
    };
  }, [location.pathname, location.search]);

  if (!visible && progress === 0) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[999] h-[2px] pointer-events-none"
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-primary transition-[width] ease-out"
        style={{
          width: `${progress}%`,
          transitionDuration: progress === 100 ? "150ms" : "300ms",
          opacity: visible ? 1 : 0,
        }}
      />
    </div>
  );
}
