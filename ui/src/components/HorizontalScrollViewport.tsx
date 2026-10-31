import type { ReactNode } from "react";
import { useHorizontalScrollEdges } from "@/hooks/useHorizontalScrollEdges";
import { cn } from "@/lib/utils";

/** One horizontal scroll owner with non-interactive clipping indicators. */
export function HorizontalScrollViewport({ children, label, contentClassName }: { children: ReactNode; label: string; contentClassName?: string }) {
  const { scrollRef, contentRef, edges } = useHorizontalScrollEdges();
  return (
    <div className="horizontal-scroll-viewport" data-overflow-left={edges.left} data-overflow-right={edges.right}>
      <div ref={scrollRef} className="horizontal-scroll-area" role="region" aria-label={label} tabIndex={0}>
        <div ref={contentRef} className={cn("horizontal-scroll-content", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
