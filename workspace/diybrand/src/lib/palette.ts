/**
 * Algorithmic color palette generator.
 *
 * Maps industry → base hue families, personality adjectives → modifiers
 * (saturation, lightness shifts), then builds 5-color palettes
 * (primary, secondary, accent, background, text) with accessible contrast.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PaletteColor = {
  role: "primary" | "secondary" | "accent" | "background" | "text";
  hex: string;
  hsl: { h: number; s: number; l: number };
};

export type Palette = {
  name: string;
  colors: PaletteColor[];
};

// ─── Industry → Base hues (0-360) ──────────────────────────────────────────

const INDUSTRY_HUES: Record<string, number[]> = {
  Technology: [210, 230, 260],
  "E-commerce": [25, 340, 260],
  "Food & Beverage": [20, 35, 10],
  "Health & Wellness": [145, 160, 120],
  Education: [215, 200, 45],
  Finance: [215, 220, 200],
  "Creative & Design": [290, 330, 15],
  "Real Estate": [175, 200, 40],
  "Fashion & Apparel": [340, 0, 280],
  "Travel & Hospitality": [190, 200, 30],
  Entertainment: [280, 330, 350],
  Consulting: [210, 190, 220],
  "Non-profit": [150, 30, 200],
  Other: [250, 200, 340],
};

// ─── Personality → modifiers ────────────────────────────────────────────────

type Modifier = { satShift: number; litShift: number; vibrancy: number };

const PERSONALITY_MODIFIERS: Record<string, Modifier> = {
  Bold: { satShift: 15, litShift: -5, vibrancy: 1.2 },
  Playful: { satShift: 10, litShift: 5, vibrancy: 1.1 },
  Elegant: { satShift: -10, litShift: 5, vibrancy: 0.85 },
  Minimal: { satShift: -20, litShift: 10, vibrancy: 0.7 },
  Warm: { satShift: 5, litShift: 0, vibrancy: 1.0 },
  Trustworthy: { satShift: -5, litShift: 0, vibrancy: 0.9 },
  Innovative: { satShift: 10, litShift: -3, vibrancy: 1.1 },
  Edgy: { satShift: 15, litShift: -10, vibrancy: 1.3 },
  Friendly: { satShift: 5, litShift: 5, vibrancy: 1.0 },
  Luxurious: { satShift: -5, litShift: -5, vibrancy: 0.8 },
  Rustic: { satShift: -15, litShift: -5, vibrancy: 0.75 },
  Modern: { satShift: 5, litShift: 0, vibrancy: 1.0 },
  Classic: { satShift: -10, litShift: 0, vibrancy: 0.85 },
  Energetic: { satShift: 15, litShift: 0, vibrancy: 1.25 },
  Calm: { satShift: -10, litShift: 10, vibrancy: 0.8 },
  Professional: { satShift: -5, litShift: 0, vibrancy: 0.9 },
  Quirky: { satShift: 10, litShift: 5, vibrancy: 1.15 },
  Sophisticated: { satShift: -10, litShift: -3, vibrancy: 0.85 },
  Organic: { satShift: -10, litShift: 5, vibrancy: 0.8 },
  Techy: { satShift: 10, litShift: -5, vibrancy: 1.1 },
};

// ─── Palette variant names ──────────────────────────────────────────────────

const VARIANT_NAMES = [
  "Classic",
  "Vibrant",
  "Muted",
  "Bold",
  "Soft",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;

  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Relative luminance (WCAG) */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two hex colors */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── Core generation ────────────────────────────────────────────────────────

function aggregateModifiers(personality: string[]): Modifier {
  const mods = personality
    .map((p) => PERSONALITY_MODIFIERS[p])
    .filter(Boolean);

  if (mods.length === 0) return { satShift: 0, litShift: 0, vibrancy: 1 };

  return {
    satShift: mods.reduce((sum, m) => sum + m.satShift, 0) / mods.length,
    litShift: mods.reduce((sum, m) => sum + m.litShift, 0) / mods.length,
    vibrancy: mods.reduce((sum, m) => sum + m.vibrancy, 0) / mods.length,
  };
}

function makeColor(
  role: PaletteColor["role"],
  h: number,
  s: number,
  l: number
): PaletteColor {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100);
  l = clamp(l, 0, 100);
  return { role, hex: hslToHex(h, s, l), hsl: { h: Math.round(h), s: Math.round(s), l: Math.round(l) } };
}

function buildPalette(
  baseHue: number,
  mod: Modifier,
  variantIndex: number
): Palette {
  // Each variant shifts the approach slightly
  const hueShift = [0, 10, -10, 15, -5][variantIndex] ?? 0;
  const satBase = clamp(65 + mod.satShift * mod.vibrancy, 25, 95);
  const litBase = clamp(45 + mod.litShift, 25, 60);

  const h = baseHue + hueShift;

  // Primary: the hero color
  const primary = makeColor("primary", h, satBase, litBase);

  // Secondary: analogous hue, slightly less saturated
  const secondary = makeColor(
    "secondary",
    h + 30 + variantIndex * 5,
    satBase - 10,
    litBase + 8
  );

  // Accent: complementary-ish hue, high energy
  const accent = makeColor(
    "accent",
    h + 150 + variantIndex * 10,
    clamp(satBase + 5, 30, 95),
    clamp(litBase + 5, 35, 60)
  );

  // Background: very light tint of primary
  const background = makeColor("background", h, clamp(satBase - 40, 5, 30), 97);

  // Text: very dark shade of primary
  let textLightness = 12;
  let textSat = clamp(satBase - 40, 5, 25);

  // Ensure text/background contrast >= 4.5:1 (WCAG AA)
  let textColor = makeColor("text", h, textSat, textLightness);
  const bgHex = background.hex;
  let tries = 0;
  while (contrastRatio(textColor.hex, bgHex) < 4.5 && tries < 10) {
    textLightness = Math.max(5, textLightness - 3);
    textSat = Math.max(5, textSat - 2);
    textColor = makeColor("text", h, textSat, textLightness);
    tries++;
  }

  return {
    name: VARIANT_NAMES[variantIndex] ?? `Variant ${variantIndex + 1}`,
    colors: [primary, secondary, accent, background, textColor],
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function generatePalettes(
  industry: string,
  personality: string[],
  count = 4
): Palette[] {
  const hues = INDUSTRY_HUES[industry] ?? INDUSTRY_HUES["Other"]!;
  const mod = aggregateModifiers(personality);

  const palettes: Palette[] = [];

  // Generate `count` palettes by cycling through base hues and variant indices
  for (let i = 0; i < count; i++) {
    const baseHue = hues[i % hues.length]!;
    palettes.push(buildPalette(baseHue, mod, i));
  }

  return palettes;
}
