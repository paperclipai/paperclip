import { useEffect, type RefObject } from "react";

const EDGE_ZONE = 60;
const MAX_SPEED = 25;
const MIN_SPEED = 2;

export function useDragSelectScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let dragging = false;
    let animationId = 0;
    let mouseY = 0;

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      dragging = true;
    }

    function onMouseUp() {
      dragging = false;
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = 0;
      }
    }

    function onMouseMove(e: MouseEvent) {
      mouseY = e.clientY;
      if (!dragging || animationId) return;
      animationId = requestAnimationFrame(tick);
    }

    function tick() {
      animationId = 0;
      if (!dragging || !el) return;

      const rect = el.getBoundingClientRect();
      const distFromTop = mouseY - rect.top;
      const distFromBottom = rect.bottom - mouseY;

      let delta = 0;
      if (distFromBottom < EDGE_ZONE && distFromBottom >= 0) {
        const t = 1 - distFromBottom / EDGE_ZONE;
        delta = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * t * t;
      } else if (distFromTop < EDGE_ZONE && distFromTop >= 0) {
        const t = 1 - distFromTop / EDGE_ZONE;
        delta = -(MIN_SPEED + (MAX_SPEED - MIN_SPEED) * t * t);
      }

      if (delta !== 0) {
        el.scrollTop += delta;
        animationId = requestAnimationFrame(tick);
      }
    }

    el.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousemove", onMouseMove);

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousemove", onMouseMove);
      if (animationId) cancelAnimationFrame(animationId);
    };
  }, [ref]);
}
