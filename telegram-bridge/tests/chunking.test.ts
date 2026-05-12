import { expect, test, describe } from "bun:test";
import { chunkMarkdownForTelegram } from "../src/chunking.js";

describe("chunkMarkdownForTelegram", () => {
  test("returns empty array for empty input", () => {
    expect(chunkMarkdownForTelegram("")).toEqual([]);
  });

  test("returns single chunk when text fits under cap", () => {
    expect(chunkMarkdownForTelegram("hello world")).toEqual(["hello world"]);
  });

  test("splits at paragraph boundary when text exceeds cap", () => {
    const para = "x".repeat(2000) + "\n\n" + "y".repeat(2500);
    const chunks = chunkMarkdownForTelegram(para, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4000);
    expect(chunks[1].length).toBeLessThanOrEqual(4000);
    expect(chunks.join("\n")).toBe(para);
  });

  test("preserves code fence boundary across chunks", () => {
    const fence = "```ts\n" + "// line\n".repeat(500) + "```";
    const chunks = chunkMarkdownForTelegram(fence, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should start with ```ts (continuation reopens) and end with ``` (closes)
    for (const chunk of chunks) {
      expect(chunk.startsWith("```ts")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }
  });

  test("hard-splits when even one line exceeds max", () => {
    const oneLine = "x".repeat(10_000);
    const chunks = chunkMarkdownForTelegram(oneLine, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });

  test("handles small max correctly", () => {
    const text = "line1\nline2\nline3";
    const chunks = chunkMarkdownForTelegram(text, 8);
    // line1 (5) + \n + line2 (5) = 11 > 8, so split.
    expect(chunks.length).toBeGreaterThan(1);
  });
});
