import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing token --${name}`).not.toBeNull();
  return match![1].trim();
}

function oklch(value: string): [number, number, number] {
  const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  expect(match, `Expected an oklch() color, got ${value}`).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

// WCAG 2 relative luminance of an oklch() color, via OKLab and linear sRGB.
function relativeLuminance(value: string): number {
  const [l, c, h] = oklch(value);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  const rgb = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("destructive theme tokens", () => {
  // Confirm buttons use `bg-destructive text-destructive-foreground`. The label
  // must stay readable on the destructive fill in both themes.
  // Light theme meets WCAG AA for normal text (4.5:1). The dark theme keeps the
  // brighter red chosen in the gallery review, so it only has to meet 3:1.
  for (const [selector, minimum] of [
    [":root", 4.5],
    [".dark", 3],
  ] as const) {
    it(`keeps destructive-foreground readable on the destructive fill in ${selector}`, () => {
      const block = cssBlock(selector);
      const fill = token(block, "destructive");
      const foreground = token(block, "destructive-foreground");

      expect(contrastRatio(foreground, fill)).toBeGreaterThanOrEqual(minimum);
    });
  }
});
