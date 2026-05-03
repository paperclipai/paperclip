import { describe, expect, it } from "vitest";
import { firstNonEmptyLine, firstSignificantStderrLine, isInformationalStderrLine } from "./utils.js";

describe("firstNonEmptyLine", () => {
  it("returns the first trimmed non-empty line", () => {
    expect(firstNonEmptyLine("\n\n  hello\nworld\n")).toBe("hello");
  });

  it("returns empty string when input is blank", () => {
    expect(firstNonEmptyLine("")).toBe("");
    expect(firstNonEmptyLine("   \n\n")).toBe("");
  });
});

describe("isInformationalStderrLine", () => {
  it("flags the YOLO mode notice as informational", () => {
    expect(
      isInformationalStderrLine("YOLO mode is enabled. All tool calls will be automatically approved."),
    ).toBe(true);
  });

  it("does not flag arbitrary error lines", () => {
    expect(isInformationalStderrLine("Error: something exploded")).toBe(false);
  });
});

describe("firstSignificantStderrLine", () => {
  it("skips the YOLO informational line and returns the next significant line", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Error: rate limit exceeded",
      "more details",
    ].join("\n");
    expect(firstSignificantStderrLine(stderr)).toBe("Error: rate limit exceeded");
  });

  it("returns empty string when stderr only contains informational notices", () => {
    expect(
      firstSignificantStderrLine(
        "YOLO mode is enabled. All tool calls will be automatically approved.\n",
      ),
    ).toBe("");
  });

  it("falls back to the first significant line when leading lines are blank or noise", () => {
    const stderr = "\n\n  YOLO mode is enabled.\n\n  real failure\n";
    expect(firstSignificantStderrLine(stderr)).toBe("real failure");
  });
});
