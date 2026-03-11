import { describe, it, expect } from "vitest";
import { appendWithCap } from "./server-utils.js";

describe("appendWithCap", () => {
  it("returns combined string when under cap", () => {
    expect(appendWithCap("hello", " world", 100)).toBe("hello world");
  });

  it("returns combined string at exactly cap", () => {
    expect(appendWithCap("ab", "cd", 4)).toBe("abcd");
  });

  it("truncates from the beginning when over cap", () => {
    expect(appendWithCap("abcde", "fgh", 5)).toBe("defgh");
  });

  it("handles empty prev", () => {
    expect(appendWithCap("", "hello", 100)).toBe("hello");
  });

  it("handles empty chunk", () => {
    expect(appendWithCap("hello", "", 100)).toBe("hello");
  });

  it("drops lone low surrogate at start after slicing", () => {
    // U+1F600 (😀) = \uD83D\uDE00 in UTF-16 (2 code units)
    // "x😀yz" indices: 0=x, 1=\uD83D, 2=\uDE00, 3=y, 4=z (length 5)
    // cap=3 → slice(2) → "\uDE00yz" — lone low surrogate at start → dropped
    const prev = "x\uD83D\uDE00";
    const chunk = "yz";
    const result = appendWithCap(prev, chunk, 3);
    expect(result).toBe("yz");
  });

  it("drops lone high surrogate at end after slicing", () => {
    // Chunk ends with a lone high surrogate (simulating a partial write)
    // "abcde\uD83D" indices: 0=a,1=b,2=c,3=d,4=e,5=\uD83D (length 6)
    // cap=4 → slice(2) → "de\uD83D" — trailing high surrogate → dropped
    const result = appendWithCap("ab", "cde\uD83D", 4);
    expect(result).toBe("cde");
  });

  it("handles string that is entirely surrogate pairs", () => {
    const emoji = "\uD83D\uDE00";
    const text = emoji.repeat(5); // 5 emojis, length 10
    expect(appendWithCap("", text, 10)).toBe(text);
  });

  it("handles cap of 1 with surrogate pair", () => {
    // "\uD83D\uDE00" length 2, cap=1 → slice(1) → "\uDE00" → dropped → ""
    expect(appendWithCap("", "\uD83D\uDE00", 1)).toBe("");
  });

  it("uses MAX_CAPTURE_BYTES as default cap", () => {
    expect(appendWithCap("", "abc")).toBe("abc");
  });

  it("preserves valid surrogate pairs when slice boundary is clean", () => {
    // "a😀b" indices: 0=a, 1=\uD83D, 2=\uDE00, 3=b (length 4)
    // cap=3 → slice(1) → "\uD83D\uDE00b" = "😀b" — pair intact
    const text = "a\uD83D\uDE00b";
    expect(appendWithCap("", text, 3)).toBe("\uD83D\uDE00b");
  });

  it("handles consecutive surrogate pairs at boundary", () => {
    const a = "\uD83D\uDE00"; // 😀
    const b = "\uD83D\uDE01"; // 😁
    // "x😀😁y" indices: 0=x, 1=\uD83D, 2=\uDE00, 3=\uD83D, 4=\uDE01, 5=y (length 6)
    // cap=5 → slice(1) → pair a intact + pair b + y
    expect(appendWithCap("", "x" + a + b + "y", 5)).toBe(a + b + "y");
    // cap=4 → slice(2) → "\uDE00😁y" → lone low surrogate dropped → "😁y"
    expect(appendWithCap("", "x" + a + b + "y", 4)).not.toMatch(/[\uDC00-\uDFFF](?![\s\S])/);
    // cap=2 → slice(4) → "\uDE01y" → lone low surrogate dropped → "y"
    expect(appendWithCap("", "x" + a + b + "y", 2)).toBe("y");
  });
});
