import { useEffect, useState, type CSSProperties } from "react";

export type MobileEntityPickerViewportStyle = CSSProperties & {
  "--mobile-entity-picker-visual-viewport-height"?: string;
  "--mobile-entity-picker-visual-viewport-offset-top"?: string;
};

type ViewportGeometry = {
  height: number;
  offsetTop: number;
};

export function readVisualViewportGeometry(): ViewportGeometry | null {
  const viewport = window.visualViewport;
  const height = viewport?.height;
  const offsetTop = viewport?.offsetTop;
  if (
    typeof height !== "number"
    || !Number.isFinite(height)
    || height <= 0
    || typeof offsetTop !== "number"
    || !Number.isFinite(offsetTop)
    || offsetTop < 0
  ) {
    return null;
  }
  return { height, offsetTop };
}

/** Keeps mobile picker sheets inside the live viewport when a keyboard opens. */
export function useMobileEntityPickerViewportStyle(): MobileEntityPickerViewportStyle {
  const [geometry, setGeometry] = useState<ViewportGeometry | null>(() =>
    typeof window === "undefined" ? null : readVisualViewportGeometry(),
  );

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const next = readVisualViewportGeometry();
      if (next) setGeometry(next);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return geometry === null
    ? {}
    : {
        "--mobile-entity-picker-visual-viewport-height": `${geometry.height}px`,
        "--mobile-entity-picker-visual-viewport-offset-top": `${geometry.offsetTop}px`,
      };
}
