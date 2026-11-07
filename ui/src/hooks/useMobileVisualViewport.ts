import { useLayoutEffect, useRef } from "react";

/** Size the mobile conversation shell, never translate it with Safari's pan.
 * CSS owns the fixed shell and its flex layout; messages own their scrolling. */
export function useMobileVisualViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !shell || !viewport) return;
    const restoreDocumentPosition = () => {
      if (viewport.scale !== 1 || shell.dataset.keyboardOpen !== "true" || !shell.querySelector("[data-task-chat-shell]")) return;
      const page = document.scrollingElement ?? document.documentElement;
      if (page.scrollTop !== 0) page.scrollTop = 0;
    };
    const update = () => {
      if (viewport.scale !== 1 || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
      // Read geometry before writing styles, avoiding a forced layout after our
      // own height update. Nothing here subscribes to input or thread updates.
      const keyboardOpen = document.documentElement.clientHeight - viewport.height > 120;
      shell.style.setProperty("--mobile-chat-viewport-height", `${viewport.height}px`);
      // innerHeight can shrink with visualViewport on iOS, so it is not the
      // keyboard-closed baseline. The layout viewport remains stable.
      if (keyboardOpen) {
        shell.dataset.keyboardOpen = "true";
      } else {
        delete shell.dataset.keyboardOpen;
      }
      restoreDocumentPosition();
    };
    update();
    viewport.addEventListener("resize", update);
    window.addEventListener("resize", update);
    // Safari can apply its pre-keyboard focus pan AFTER the resize. The fixed
    // document is not a scroll surface. Listen without capture so scrolls in
    // the message list/editor never reach this fallback.
    document.addEventListener("scroll", restoreDocumentPosition);
    return () => {
      viewport.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", restoreDocumentPosition);
      shell.style.removeProperty("--mobile-chat-viewport-height");
      delete shell.dataset.keyboardOpen;
    };
  }, [enabled]);
  return ref;
}
