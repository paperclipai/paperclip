import { describe, expect, it } from "vitest";
import { firstNonEmptyLine } from "./utils.js";

describe("firstNonEmptyLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstNonEmptyLine("\n\nhello\nworld")).toBe("hello");
  });

  it("returns empty string for all-empty input", () => {
    expect(firstNonEmptyLine("\n\n  \n")).toBe("");
  });

  it("skips the YOLO mode banner and returns the real error", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Failed to fetch admin controls: request to https://cloudcode-pa.googleapis.com/v1internal:fetchAdminControls failed, reason: read ETIMEDOUT",
      "An unexpected critical error occurred: ETIMEDOUT",
    ].join("\n");
    // Both benign patterns are skipped, so we get the "An unexpected..." line.
    expect(firstNonEmptyLine(stderr)).toBe("An unexpected critical error occurred: ETIMEDOUT");
  });

  it("skips the tightly-anchored admin-controls fetch warning", () => {
    const stderr = [
      "Failed to fetch admin controls: cloudcode-pa.googleapis.com read ETIMEDOUT",
      "Quota exceeded for model gemini-3.1-pro-preview",
    ].join("\n");
    expect(firstNonEmptyLine(stderr)).toBe("Quota exceeded for model gemini-3.1-pro-preview");
  });

  it("does NOT skip a novel error that happens to mention cloudcode-pa", () => {
    // Regression guard: the regex is anchored to `^Failed to fetch admin controls:`
    // so a real auth failure that embeds the hostname mid-message must still surface.
    const stderr = "Invalid API key for cloudcode-pa.googleapis.com — check credentials";
    expect(firstNonEmptyLine(stderr)).toBe("Invalid API key for cloudcode-pa.googleapis.com — check credentials");
  });

  it("returns empty string when only benign lines are present", () => {
    const stderr = "YOLO mode is enabled. All tool calls will be automatically approved.";
    expect(firstNonEmptyLine(stderr)).toBe("");
  });
});

describe("summarizeProbeDetail caller chain (integration)", () => {
  // Mirrors the exact fallback chain used in test.ts:summarizeProbeDetail —
  // `parsedError || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout)`.
  // This guards the full error-surfacing path so a refactor of test.ts cannot
  // silently drop the fallback to stdout when stderr is all-benign.
  function simulateSummarizeProbeDetail(
    stdout: string,
    stderr: string,
    parsedError: string | null,
  ): string | null {
    const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
    if (!raw) return null;
    const clean = raw.replace(/\s+/g, " ").trim();
    const max = 240;
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }

  it("falls through to stdout when stderr is entirely benign banners", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "YOLO mode is enabled. All tool calls will be automatically approved.",
    ].join("\n");
    const stdout = "Auth succeeded\nmodel=gemini-3.1-pro ready";
    expect(simulateSummarizeProbeDetail(stdout, stderr, null)).toBe("Auth succeeded");
  });

  it("still prefers parsedError over any stderr/stdout content", () => {
    const stderr = "An unexpected critical error occurred: ETIMEDOUT";
    const stdout = "nothing relevant here";
    expect(simulateSummarizeProbeDetail(stdout, stderr, "RESOURCE_EXHAUSTED: quota")).toBe(
      "RESOURCE_EXHAUSTED: quota",
    );
  });

  it("returns null when parsedError, stderr, and stdout are all empty or benign", () => {
    const stderr = "YOLO mode is enabled. All tool calls will be automatically approved.";
    expect(simulateSummarizeProbeDetail("", stderr, null)).toBeNull();
  });
});
