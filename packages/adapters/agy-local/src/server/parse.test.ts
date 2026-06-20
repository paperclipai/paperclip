import { describe, it, expect } from "vitest";
import { parseAgyOutput, detectAgyAuthRequired } from "./parse.js";

describe("parseAgyOutput", () => {
  it("returns finalMessage for non-empty stdout", () => {
    const result = parseAgyOutput("Task completed successfully.\n");
    expect(result.finalMessage).toBe("Task completed successfully.");
    expect(result.errors).toHaveLength(0);
  });

  it("returns null finalMessage for empty stdout", () => {
    expect(parseAgyOutput("").finalMessage).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseAgyOutput("  hello  \n").finalMessage).toBe("hello");
  });

  it("returns null for whitespace-only stdout", () => {
    expect(parseAgyOutput("   \n\n").finalMessage).toBeNull();
  });

  it("preserves multi-line output", () => {
    const output = "Line 1\nLine 2";
    expect(parseAgyOutput(output).finalMessage).toBe(output);
  });
});

describe("detectAgyAuthRequired", () => {
  it("detects 'not logged into antigravity'", () => {
    expect(detectAgyAuthRequired("", "not logged into antigravity")).toBe(true);
  });

  it("detects 'agy auth login' suggestion", () => {
    expect(detectAgyAuthRequired("", "run agy auth login")).toBe(true);
  });

  it("detects 'error getting token source'", () => {
    expect(detectAgyAuthRequired("", "error getting token source")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectAgyAuthRequired("", "NOT LOGGED INTO ANTIGRAVITY")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(detectAgyAuthRequired("Task done.", "")).toBe(false);
  });

  it("also checks stdout", () => {
    expect(detectAgyAuthRequired("not logged into antigravity", "")).toBe(true);
  });
});
