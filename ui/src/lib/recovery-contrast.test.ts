import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { RECOVERY_CHIP_DEFAULT_TONE } from "./recovery-display";

/**
 * PAP-17083 — contrast guard for the recessed recovery treatments.
 *
 * End-to-end QA (PAP-17061) measured the recessed recovery chip at 4.34:1 in
 * real Chromium: `text-muted-foreground` on solid `bg-muted`, rendered at
 * `--text-nano`, where the WCAG AA bar is 4.5:1. This file pins the arithmetic
 * so the pairing cannot silently regress between browser QA passes.
 *
 * The oklch → sRGB conversion below is calibrated against values measured in
 * Chromium 151 (see CHROMIUM_ANCHORS): if the conversion ever drifts, the
 * anchor test fails first and every ratio in this file is treated as suspect.
 */

// ---------------------------------------------------------------------------
// oklch → sRGB (CSS Color 4). Calibrated, not trusted blindly.
// ---------------------------------------------------------------------------

function oklchToSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const encode = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [encode(lr), encode(lg), encode(lb)];
}

/** WCAG 2.x relative luminance. The 1.055 denominator is load-bearing. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Token values, read from the real stylesheet so the guard tracks the source.
// ---------------------------------------------------------------------------

const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../index.css"),
  "utf8",
);

/** `:root { … }` is light; `.dark { … }` is dark. */
function readToken(name: string, theme: "light" | "dark"): [number, number, number] {
  // The dark block redeclares every token, so the LAST occurrence is dark and
  // the first is light.
  const re = new RegExp(`^\\s*--${name}:\\s*oklch\\(([^)]+)\\)`, "gm");
  const hits = [...CSS.matchAll(re)];
  expect(hits.length, `expected --${name} declared for both themes`).toBeGreaterThanOrEqual(2);
  const raw = (theme === "light" ? hits[0] : hits[hits.length - 1])![1]!;
  const [L, C, H] = raw.trim().split(/\s+/).map(Number) as [number, number, number];
  return oklchToSrgb(L, C ?? 0, H ?? 0);
}

// Ground truth sampled from Chromium 151 while measuring the real Storybook
// surfaces. If oklchToSrgb stops reproducing these, the maths has drifted.
const CHROMIUM_ANCHORS: Array<{ oklch: [number, number, number]; srgb: [number, number, number] }> = [
  { oklch: [0.556, 0, 0], srgb: [115, 115, 115] }, // light --muted-foreground (#737373)
  { oklch: [0.97, 0, 0], srgb: [245, 245, 245] }, // light --muted (#f5f5f5)
  { oklch: [0.145, 0, 0], srgb: [10, 10, 10] }, // dark --background
  { oklch: [0.708, 0, 0], srgb: [161, 161, 161] }, // dark --muted-foreground
  { oklch: [1, 0, 0], srgb: [255, 255, 255] }, // light --background
];

const AA_SMALL_TEXT = 4.5;

describe("recovery chip contrast (PAP-17083)", () => {
  it("reproduces Chromium's oklch → sRGB conversion", () => {
    for (const { oklch, srgb } of CHROMIUM_ANCHORS) {
      const got = oklchToSrgb(oklch[0], oklch[1], oklch[2]);
      // ±1 allows for rounding differences only.
      for (let i = 0; i < 3; i += 1) {
        expect(
          Math.abs(got[i]! - srgb[i]!),
          `oklch(${oklch.join(" ")}) → expected ~${srgb} got ${got}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("agrees with the browser on the regression QA actually measured", () => {
    // PAP-17061 and axe-core both measured this pairing at 4.34:1.
    const ratio = contrast(readToken("muted-foreground", "light"), readToken("muted", "light"));
    expect(ratio).toBeCloseTo(4.34, 1);
  });

  // -- the guard ------------------------------------------------------------

  it("renders every recessed chip on an AA-safe neutral in light mode", () => {
    const fg = readToken("recessed-foreground", "light");
    const bg = readToken("muted", "light");
    const ratio = contrast(fg, bg);
    expect(
      ratio,
      `recessed chip text on bg-muted measured ${ratio.toFixed(2)}:1, below AA at --text-nano`,
    ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  it("keeps the recessed chip AA in dark mode", () => {
    const ratio = contrast(readToken("recessed-foreground", "dark"), readToken("muted", "dark"));
    expect(ratio).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  it("keeps the recessed foreground AA on plain paper too", () => {
    for (const theme of ["light", "dark"] as const) {
      const ratio = contrast(readToken("recessed-foreground", theme), readToken("background", theme));
      expect(ratio, `${theme} recessed-on-background = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_SMALL_TEXT,
      );
    }
  });

  it("routes the recessed chip states through the AA-safe token, never the paper neutral", () => {
    for (const state of ["in_progress", "observe_only"] as const) {
      const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
      expect(tone.recessed, `${state} must stay recessed`).toBe(true);
      expect(tone.className).toContain("text-recessed-foreground");
      // `--muted-foreground` is the 4.34:1 failure; it must not come back...
      expect(tone.className).not.toMatch(/text-muted-foreground(?![-\w])/);
      // ...and no opacity modifier may dilute the replacement either.
      expect(tone.className).not.toMatch(/text-[\w-]*foreground\/\d+/);
    }
  });

  it("keeps prominent states prominent so the hierarchy still reads", () => {
    for (const state of ["needed", "escalated"] as const) {
      expect(RECOVERY_CHIP_DEFAULT_TONE[state].recessed).toBe(false);
      expect(RECOVERY_CHIP_DEFAULT_TONE[state].className).toMatch(/amber|red/);
    }
  });

  // -- negative control -----------------------------------------------------

  /**
   * Proves this file can actually detect the failure it was written for. If the
   * conversion or the luminance maths silently breaks, the guards above go
   * green for the wrong reason — this control goes green too, and that is the
   * signal that the whole file is worthless.
   */
  it("negative control: the retired treatment still measures as a failure", () => {
    const regressed = contrast(readToken("muted-foreground", "light"), readToken("muted", "light"));
    expect(regressed).toBeLessThan(AA_SMALL_TEXT);
    expect(regressed).toBeGreaterThan(4); // a near-miss, exactly as QA reported

    // And the fix must be a real improvement over it, not a rounding win.
    const fixed = contrast(readToken("recessed-foreground", "light"), readToken("muted", "light"));
    expect(fixed - regressed).toBeGreaterThan(0.5);
  });
});
