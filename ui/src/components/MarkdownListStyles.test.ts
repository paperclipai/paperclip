import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyStart, `Missing CSS block start: ${selector}`).toBeGreaterThanOrEqual(0);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

describe("rendered markdown list styles", () => {
  it("keeps enough gutter for multi-digit ordered-list markers", () => {
    const block = cssBlock(".paperclip-markdown :where(ul, ol)");
    const padding = block.match(/padding-left:\s*([0-9.]+)rem/);

    expect(padding?.[1], "Expected markdown lists to use rem padding").toBeDefined();
    expect(Number(padding?.[1])).toBeGreaterThanOrEqual(2.5);
  });
});
