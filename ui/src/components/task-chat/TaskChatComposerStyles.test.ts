import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function customPropertyValue(name: string): string {
  const match = stylesheet.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing CSS custom property: ${name}`).not.toBeNull();
  return match?.[1].trim() ?? "";
}

describe("task-chat composer styles", () => {
  it("wraps long placeholders within the composer instead of clipping them", () => {
    const block = cssBlock(
      '.paperclip-task-chat-composer .paperclip-mdxeditor [class*="_placeholder_"]',
    );

    expect(block).toContain("display: block");
    expect(block).toContain("width: 100%");
    expect(block).toContain("overflow-wrap: anywhere");
    expect(block).toContain("white-space: normal");
  });

  it("keeps the composer's combined shadow valid with full-color semantic tokens", () => {
    const shadow = customPropertyValue("--shadow-extract-7");

    expect(shadow).toContain("color-mix(in oklab, var(--primary) 16%, transparent)");
    expect(shadow).not.toContain("hsl(var(");
  });
});
