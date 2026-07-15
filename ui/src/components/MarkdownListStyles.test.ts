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

function remPaddingLeft(selector: string): number {
  const padding = cssBlock(selector).match(/padding-left:\s*([0-9.]+)rem/);

  expect(padding?.[1], `Expected ${selector} to use rem padding`).toBeDefined();
  return Number(padding?.[1]);
}

describe("rendered markdown list styles", () => {
  it("keeps unordered-list gutters compact while giving ordered markers enough room", () => {
    expect(remPaddingLeft(".paperclip-markdown :where(ul, ol)")).toBeLessThan(2.5);
    expect(remPaddingLeft(".paperclip-markdown ol")).toBeGreaterThanOrEqual(2.5);
  });
});
