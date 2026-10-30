import { useLayoutEffect, useRef, useState } from "react";

/** Track clipping as the viewport, content or scroll position changes. */
export function useHorizontalScrollEdges() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      const left = scroller.scrollLeft > 1;
      const right = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
      setEdges(current => current.left === left && current.right === right ? current : { left, right });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  return { scrollRef, contentRef, edges };
}
