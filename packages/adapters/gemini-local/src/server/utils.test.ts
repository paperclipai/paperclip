import { describe, expect, it } from "vitest";
import { firstMeaningfulStderrLine, firstNonEmptyLine } from "./utils.js";

describe("firstNonEmptyLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstNonEmptyLine("hello\nworld")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(firstNonEmptyLine("")).toBe("");
  });

  it("skips blank lines", () => {
    expect(firstNonEmptyLine("\n\nhello")).toBe("hello");
  });
});

describe("firstMeaningfulStderrLine — issue #3462 regression", () => {
  const YOLO_NOISE = "YOLO mode is enabled. All tool calls will be automatically approved.";
  const PGREP_NOISE = "missing pgrep output";
  const MCP_NOISE = "Loaded MCP server: paperclip";

  it("skips YOLO startup noise and returns the actual error", () => {
    const stderr = [
      YOLO_NOISE,
      "Error: _recoverFromLoop triggered — repetitive tool calls detected",
    ].join("\n");

    expect(firstMeaningfulStderrLine(stderr)).toBe(
      "Error: _recoverFromLoop triggered — repetitive tool calls detected",
    );
  });

  it("skips missing pgrep output noise", () => {
    const stderr = [PGREP_NOISE, "Error: process exited unexpectedly"].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe("Error: process exited unexpectedly");
  });

  it("skips MCP loader status lines", () => {
    const stderr = [MCP_NOISE, "Error: quota exceeded"].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe("Error: quota exceeded");
  });

  it("skips multiple leading noise lines before reaching real error", () => {
    const stderr = [YOLO_NOISE, MCP_NOISE, PGREP_NOISE, "Fatal: out of memory"].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe("Fatal: out of memory");
  });

  it("returns empty string when stderr contains only noise", () => {
    const stderr = [YOLO_NOISE, PGREP_NOISE].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(firstMeaningfulStderrLine("")).toBe("");
  });

  it("returns meaningful line when no noise is present", () => {
    const stderr = "Error: API quota exceeded";
    expect(firstMeaningfulStderrLine(stderr)).toBe("Error: API quota exceeded");
  });

  it("is case-insensitive for noise pattern matching", () => {
    const stderr = ["yolo mode is enabled. something something", "Real error"].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe("Real error");
  });
});
