import { useEffect, useState, type CSSProperties } from "react";

export type MobileEntityPickerViewportStyle = CSSProperties & {
  "--mobile-entity-picker-visual-viewport-height"?: string;
};

function readVisualViewportHeight() {
  const height = window.visualViewport?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? height
    : null;
}

/** Keeps mobile picker sheets inside the live viewport when a keyboard opens. */
export function useMobileEntityPickerViewportStyle(): MobileEntityPickerViewportStyle {
  const [height, setHeight] = useState<number | null>(() =>
    typeof window === "undefined" ? null : readVisualViewportHeight(),
  );

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const next = readVisualViewportHeight();
      if (next !== null) setHeight(next);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return height === null
    ? {}
    : { "--mobile-entity-picker-visual-viewport-height": `${height}px` };
}
