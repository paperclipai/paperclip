import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

describe("native select option styles", () => {
  it("paints options with the popover colors so transparent selects stay readable in dark mode", () => {
    const block = cssBlock("select optgroup");
    expect(block).toMatch(/background-color:\s*var\(--popover\);/);
    expect(block).toMatch(/(?<!-)color:\s*var\(--popover-foreground\);/);
  });
});
