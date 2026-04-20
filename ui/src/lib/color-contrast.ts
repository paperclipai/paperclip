/**
 * Shared color-contrast utilities for pill / badge / chip components.
 *
 * Uses WCAG 2.1 relative-luminance contrast ratios so text is always
 * readable, even on semi-transparent backgrounds composited over dark or
 * light page backgrounds.
 */

const DARK_BG = { r: 24, g: 24, b: 27 }; // zinc-900 (#18181b)
const LIGHT_BG = { r: 255, g: 255, b: 255 }; // white

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{3,6})$/i.exec(hex.trim());
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
  }
  if (value.length !== 6) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * relativeLuminanceChannel(r) +
    0.7152 * relativeLuminanceChannel(g) +
    0.0722 * relativeLuminanceChannel(b)
  );
}

function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isDarkMode(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

/**
 * Composite a foreground RGB at the given alpha over a background RGB.
 */
function composite(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
  alpha: number,
): { r: number; g: number; b: number } {
  return {
    r: Math.round(alpha * fg.r + (1 - alpha) * bg.r),
    g: Math.round(alpha * fg.g + (1 - alpha) * bg.g),
    b: Math.round(alpha * fg.b + (1 - alpha) * bg.b),
  };
}

const TEXT_LIGHT = "#f8fafc";
const TEXT_DARK = "#111827";

/**
 * Pick a readable text color for a solid background.
 * Uses WCAG contrast ratios to choose between light and dark text.
 */
export function pickTextColorForSolidBg(hexColor: string): string {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return TEXT_LIGHT;
  const bgLum = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const whiteLum = relativeLuminance(248, 250, 252);
  const blackLum = relativeLuminance(17, 24, 39);
  return contrastRatio(bgLum, whiteLum) >= contrastRatio(bgLum, blackLum)
    ? TEXT_LIGHT
    : TEXT_DARK;
}

/**
 * Pick a readable text color for a semi-transparent pill background.
 *
 * Composites `rgba(hexColor, alpha)` over the current page background
 * (dark or light mode) and then picks the text color with better
 * WCAG contrast ratio.
 */
export function pickTextColorForPillBg(hexColor: string, alpha = 0.22): string {
  const fg = hexToRgb(hexColor);
  if (!fg) return TEXT_LIGHT;
  const pageBg = isDarkMode() ? DARK_BG : LIGHT_BG;
  const effectiveBg = composite(fg, pageBg, alpha);
  const bgLum = relativeLuminance(effectiveBg.r, effectiveBg.g, effectiveBg.b);
  const whiteLum = relativeLuminance(248, 250, 252);
  const blackLum = relativeLuminance(17, 24, 39);
  return contrastRatio(bgLum, whiteLum) >= contrastRatio(bgLum, blackLum)
    ? TEXT_LIGHT
    : TEXT_DARK;
}
