import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TaskChatComposerDockProps {
  children: ReactNode;
  mobile: boolean;
  streamlined: boolean;
  concealed?: boolean;
}

export function TaskChatComposerDock({ children, mobile, streamlined, concealed = false }: TaskChatComposerDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const thread = dock?.closest<HTMLElement>('[data-testid="task-chat-thread"]');
    if (!dock || !thread || !thread.closest(".coordinator-workspace")) return;
    const forwardGapWheel = (event: WheelEvent) => {
      if (event.target !== dock || event.ctrlKey || event.defaultPrevented) return;
      const scroller = thread.querySelector<HTMLElement>('[data-testid="task-chat-scroller"]');
      if (!scroller) return;
      event.preventDefault();
      const { deltaX, deltaY, deltaMode, altKey, ctrlKey, metaKey, shiftKey } = event;
      if (!scroller.dispatchEvent(new WheelEvent("wheel", {
        deltaX, deltaY, deltaMode, altKey, ctrlKey, metaKey, shiftKey, bubbles: true, cancelable: true,
      }))) return;
      const style = window.getComputedStyle(scroller);
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize;
      const verticalUnit = deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight
        : deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
      const horizontalUnit = deltaMode === WheelEvent.DOM_DELTA_LINE ? fontSize / 2
        : deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientWidth : 1;
      scroller.scrollBy({ left: deltaX * horizontalUnit, top: deltaY * verticalUnit, behavior: "instant" });
    };
    dock.addEventListener("wheel", forwardGapWheel, { passive: false });
    const measure = () => thread.style.setProperty("--task-composer-dock-height", `${dock.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    return () => {
      dock.removeEventListener("wheel", forwardGapWheel);
      observer?.disconnect();
      thread.style.removeProperty("--task-composer-dock-height");
    };
  }, []);
  return <div
    ref={dockRef}
    data-testid="task-chat-composer-dock"
    data-conversation-typography=""
    inert={concealed}
    aria-hidden={concealed || undefined}
    className={cn(
      "flex max-w-(--tc-shell-max-w) shrink-0 flex-col gap-2",
      concealed && "invisible",
      mobile
        ? cn("w-auto px-1 pb-1", streamlined ? "-mx-2" : "mx-2")
        : "mx-auto w-full px-1 pb-1 md:px-4 md:pb-2",
      streamlined && "md:px-0 md:pb-0",
      (!streamlined || mobile) &&
        "bg-background/80 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 dark:bg-transparent dark:backdrop-blur-none dark:supports-[backdrop-filter]:bg-transparent",
    )}
  >
    {children}
  </div>;
}
