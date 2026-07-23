import { useEffect, useState } from "react";

function getMediaQuery(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

function isTouchOnlyPointer(): boolean {
  const hoverNoneQuery = getMediaQuery("(hover: none)");
  const anyHoverQuery = getMediaQuery("(any-hover: hover)");
  return (
    typeof navigator !== "undefined"
    && navigator.maxTouchPoints > 0
    && hoverNoneQuery?.matches === true
    && anyHoverQuery?.matches !== true
  );
}

function currentCoarsePointer(pointerQuery?: MediaQueryList | null): boolean {
  return (pointerQuery ?? getMediaQuery("(pointer: coarse)"))?.matches === true || isTouchOnlyPointer();
}

export function useCoarsePointer(): boolean {
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => currentCoarsePointer());

  useEffect(() => {
    const pointerQuery = getMediaQuery("(pointer: coarse)");
    const hoverNoneQuery = getMediaQuery("(hover: none)");
    const anyHoverQuery = getMediaQuery("(any-hover: hover)");
    if (!pointerQuery && !hoverNoneQuery && !anyHoverQuery) return;

    const update = () => setIsCoarsePointer(currentCoarsePointer(pointerQuery));
    update();
    pointerQuery?.addEventListener("change", update);
    hoverNoneQuery?.addEventListener("change", update);
    anyHoverQuery?.addEventListener("change", update);
    return () => {
      pointerQuery?.removeEventListener("change", update);
      hoverNoneQuery?.removeEventListener("change", update);
      anyHoverQuery?.removeEventListener("change", update);
    };
  }, []);

  return isCoarsePointer;
}
