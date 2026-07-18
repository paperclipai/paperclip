// WCAG 2.1 relative-luminance / contrast-ratio helpers for the Brand Kit editor
// (NEO-271). Pure functions — no DOM — so they are unit-testable and cheap to run
// on every keystroke for live contrast warnings.

// Parse #RGB / #RRGGBB / #RRGGBBAA into 0-255 channels. Returns null for anything
// that is not a valid hex color (alpha, if present, is ignored for luminance).
export function parseHex(input: string): { r: number; g: number; b: number } | null {
  const value = input.trim();
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// WCAG relative luminance in [0,1].
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

// Contrast ratio in [1, 21]. Returns null if either color fails to parse.
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export type WcagLevel = "AAA" | "AA" | "AA Large" | "Fail";

// Grade a ratio against the WCAG thresholds for normal-weight text.
export function gradeContrast(ratio: number): WcagLevel {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA Large";
  return "Fail";
}

// Pick black or white text for a given background, whichever has more contrast.
export function readableTextColor(background: string): "#000000" | "#ffffff" {
  const onWhite = contrastRatio(background, "#ffffff") ?? 0;
  const onBlack = contrastRatio(background, "#000000") ?? 0;
  return onBlack >= onWhite ? "#000000" : "#ffffff";
}
