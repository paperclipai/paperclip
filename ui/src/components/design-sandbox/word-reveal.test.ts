import { describe, expect, it } from "vitest";
import { revealWordProgress, revealWords, wordCount } from "./word-reveal";

describe("whole-word preview streaming", () => {
  it("preserves Markdown, Unicode and whitespace without partial words", () => {
    const text = "  I’ll inspect **components**.\n\n`ui/src/` is next.  ";
    expect(wordCount(text)).toBe(6);
    expect(revealWords(text, 0)).toBe("");
    expect(revealWords(text, 1)).toBe("  I’ll ");
    expect(revealWords(text, 3)).toBe("  I’ll inspect **components**.\n\n");
    expect(revealWords(text, Infinity)).toBe(text);
    const prefixes = Array.from({ length: 101 }, (_, index) => revealWordProgress(text, index / 100));
    const completePrefixes = new Set(Array.from({ length: 6 }, (_, index) => revealWords(text, index + 1)));
    expect(prefixes.every(prefix => completePrefixes.has(prefix))).toBe(true);
    expect(prefixes.at(-1)).toBe(text);
  });
  it("handles empty text and a single long word", () => {
    expect(revealWordProgress("", 0.5)).toBe("");
    expect(revealWordProgress("reconnection", 0.2)).toBe("reconnection");
    expect(revealWordProgress("one two", 2)).toBe("one two");
  });
});
