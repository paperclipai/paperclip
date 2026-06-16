import { describe, expect, it } from "vitest";
import { stripThinkBlocks } from "./execute.js";

describe("stripThinkBlocks", () => {
  it("strips a single-line think block, leaving the rest", () => {
    expect(stripThinkBlocks("<think>internal reasoning</think>done")).toBe("done");
  });

  it("strips a multiline think block (dotall)", () => {
    const input = "<think>\nstep 1\nstep 2\n</think>Result text";
    expect(stripThinkBlocks(input)).toBe("Result text");
  });

  it("strips multiple think blocks", () => {
    const input = "<think>a</think>middle<think>b</think>end";
    expect(stripThinkBlocks(input)).toBe("middleend");
  });

  it("is inert when no think block is present", () => {
    const text = "Hello, this is normal output with no think tags.";
    expect(stripThinkBlocks(text)).toBe(text);
  });

  it("does not corrupt JSON payloads with no think tags", () => {
    const json = '{"key":"value","array":[1,2,3],"nested":{"ok":true}}';
    expect(stripThinkBlocks(json)).toBe(json);
  });

  it("does not match arbitrary angle-bracket words (only literal think tags)", () => {
    const text = "a <b>bold</b> word";
    expect(stripThinkBlocks(text)).toBe(text);
  });

  it("trims leading whitespace left after stripping a leading think block", () => {
    const input = "<think>reasoning</think>\n\nActual answer.";
    expect(stripThinkBlocks(input)).toBe("Actual answer.");
  });

  it("is non-greedy: two think blocks do not merge into one match", () => {
    const input = "<think>A</think>KEEP<think>B</think>";
    expect(stripThinkBlocks(input)).toBe("KEEP");
  });
});
