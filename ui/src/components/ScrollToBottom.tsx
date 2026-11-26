import { useCallback, useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";
import { createPortal } from "react-dom";
import { useSidebar } from "../context/SidebarContext";
import { usePanel } from "../context/PanelContext";
import { cn } from "../lib/utils";

function resolveScrollTarget() {
  const mainContent = document.getElementById("main-content");

  if (mainContent instanceof HTMLElement) {
    const overflowY = window.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && mainContent.scrollHeight > mainContent.clientHeight + 1;

    if (usesOwnScroll) {
      return { type: "element" as const, element: mainContent };
    }
  }

  return { type: "window" as const };
}

function distanceFromBottom(target: ReturnType<typeof resolveScrollTarget>) {
  if (target.type === "element") {
    return target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollHeight - window.scrollY - window.innerHeight;
}

/**
 * Floating scroll-to-bottom button that follows the active page scroller.
 * On desktop that is `#main-content`; on mobile it falls back to window/page scroll.
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);
  const { panelVisible, panelContent } = usePanel();
  const { isMobile } = useSidebar();
  const [composerDock, setComposerDock] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!isMobile) {
      setComposerDock(null);
      return;
    }
    const main = document.getElementById("main-content");
    if (!main) return;
    const findDock = () => setComposerDock(
      main.querySelector<HTMLElement>('[data-testid="task-chat-composer-dock"]'),
    );
    findDock();
    const observer = new MutationObserver(findDock);
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromBottom(resolveScrollTarget()) > 300);
    };

    const mainContent = document.getElementById("main-content");

    check();
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    return () => {
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  const scroll = useCallback(() => {
    const target = resolveScrollTarget();

    if (target.type === "element") {
      target.element.scrollTo({ top: target.element.scrollHeight, behavior: "smooth" });
      return;
    }

    const scroller = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  if (!visible) return null;

  const button = (
    <button
      data-slot="icon-button"
      onClick={scroll}
      className={cn(
        "z-40 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-(--tp-background-color-right) duration-200",
        isMobile && composerDock
          ? "absolute bottom-full left-1/2 -translate-x-1/2 mb-3"
          : "fixed bottom-(--sz-calc-21) right-6 md:bottom-6",
        !isMobile && panelVisible && panelContent && "md:right-(--sz-calc-22)",
      )}
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
  // Anchoring to the dock follows editor growth and the nav's sticky offset.
  return isMobile && composerDock ? createPortal(button, composerDock) : button;
}
