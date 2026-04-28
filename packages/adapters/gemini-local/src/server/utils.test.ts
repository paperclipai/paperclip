import { describe, expect, it } from "vitest";
import { firstNonEmptyLine } from "./utils.js";

describe("firstNonEmptyLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstNonEmptyLine("\n\nhello\nworld")).toBe("hello");
  });

  it("returns empty string for all-empty input", () => {
    expect(firstNonEmptyLine("\n\n  \n")).toBe("");
  });

  it("skips YOLO banner and returns the real error", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Failed to fetch admin controls: request to https://cloudcode-pa.googleapis.com/v1internal:fetchAdminControls failed, reason: read ETIMEDOUT",
      "An unexpected critical error occurred: ETIMEDOUT",
    ].join("\n");
    expect(firstNonEmptyLine(stderr)).toBe("An unexpected critical error occurred: ETIMEDOUT");
  });

  it("skips admin-controls fetch warning", () => {
    const stderr = [
      "Failed to fetch admin controls: cloudcode-pa.googleapis.com read ETIMEDOUT",
      "Quota exceeded for model gemini-3.1-pro-preview",
    ].join("\n");
    expect(firstNonEmptyLine(stderr)).toBe("Quota exceeded for model gemini-3.1-pro-preview");
  });

  it("does NOT skip novel errors mentioning cloudcode-pa mid-message", () => {
    const stderr = "Invalid API key for cloudcode-pa.googleapis.com — check credentials";
    expect(firstNonEmptyLine(stderr)).toBe(stderr);
  });

  it("returns empty string when only benign lines are present", () => {
    const stderr = "YOLO mode is enabled. All tool calls will be automatically approved.";
    expect(firstNonEmptyLine(stderr)).toBe("");
  });
});

describe("fallback chain integration", () => {
  function simulateFallback(
    stdout: string,
    stderr: string,
    parsedError: string | null,
  ): string | null {
    const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
    if (!raw) return null;
    const clean = raw.replace(/\s+/g, " ").trim();
    return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
  }

  it("falls through to stdout when stderr is entirely benign", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "YOLO mode is enabled. All tool calls will be automatically approved.",
    ].join("\n");
    expect(simulateFallback("Auth succeeded\nmodel ready", stderr, null)).toBe("Auth succeeded");
  });

  it("prefers parsedError over stderr/stdout", () => {
    expect(simulateFallback("stdout", "An error", "RESOURCE_EXHAUSTED")).toBe("RESOURCE_EXHAUSTED");
  });

  it("returns null when everything is empty or benign", () => {
    const stderr = "YOLO mode is enabled. All tool calls will be automatically approved.";
    expect(simulateFallback("", stderr, null)).toBeNull();
  });
});
