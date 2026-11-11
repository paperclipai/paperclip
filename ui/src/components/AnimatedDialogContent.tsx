import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { DialogContent } from "./ui/dialog";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { motionEase, motionMilliseconds } from "@/lib/onboarding-motion-tokens";
import { cn } from "@/lib/utils";

/** Animate natural content-height changes without scaling text or moving focus. */
export function AnimatedDialogContent({ children, className, ...props }: ComponentProps<typeof DialogContent>) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const outer = panel;
    const inner = content.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    let previous: number | undefined;
    let animation: Animation | undefined;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(outer);
      const next = inner.getBoundingClientRect().height + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      if (next === previous) return;
      const from = animation?.playState === "running" ? outer.getBoundingClientRect().height : previous;
      animation?.cancel();
      previous = next;
      if (from === undefined || reducedMotion || typeof outer.animate !== "function") return;
      const ease = motionEase("--motion-ease-out-expo");
      animation = outer.animate([{ height: `${from}px` }, { height: `${next}px` }], {
        duration: motionMilliseconds("--onboarding-motion-step"),
        easing: Array.isArray(ease) ? `cubic-bezier(${ease.join(",")})` : ease,
      });
    });
    observer.observe(inner);
    return () => { observer.disconnect(); animation?.cancel(); };
  }, [panel, reducedMotion]);
  return <DialogContent {...props} ref={setPanel} className={cn("overflow-hidden p-0", className)}>
    <div ref={content} className="flex max-h-(--sz-calc-18) shrink-0 flex-col">{children}</div>
  </DialogContent>;
}
