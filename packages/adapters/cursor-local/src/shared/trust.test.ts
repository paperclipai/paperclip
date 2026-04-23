import { describe, expect, it } from "vitest";
import { hasCursorTrustBypassArg } from "./trust.js";

describe("hasCursorTrustBypassArg", () => {
  it("returns true for --trust flag", () => {
    expect(hasCursorTrustBypassArg(["--trust"])).toBe(true);
  });

  it("returns true for --yolo flag", () => {
    expect(hasCursorTrustBypassArg(["--yolo"])).toBe(true);
  });

  it("returns true for -f flag", () => {
    expect(hasCursorTrustBypassArg(["-f"])).toBe(true);
  });

  it("returns true for --trust=value", () => {
    expect(hasCursorTrustBypassArg(["--trust=always"])).toBe(true);
  });

  it("returns true when trust flag is among other args", () => {
    expect(hasCursorTrustBypassArg(["--model", "gpt-4", "--yolo", "--output", "file"])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(hasCursorTrustBypassArg([])).toBe(false);
  });

  it("returns false when no trust flags present", () => {
    expect(hasCursorTrustBypassArg(["--model", "claude-3", "--output", "file.md"])).toBe(false);
  });

  it("returns false for similar but non-matching flags", () => {
    expect(hasCursorTrustBypassArg(["--untrust", "--trusting", "--trust-me"])).toBe(false);
  });

  it("returns false for partial -f match within a longer flag", () => {
    expect(hasCursorTrustBypassArg(["--format"])).toBe(false);
  });
});
