import { describe, expect, it } from "vitest";
import {
  stripAnsi,
  parseCredits,
  parseTimeSeconds,
  parseKiroOutput,
  isKiroUnknownSessionError,
} from "./parse.js";

describe("stripAnsi", () => {
  it("strips basic ANSI color codes", () => {
    const input = "\x1b[31mError message\x1b[0m";
    expect(stripAnsi(input)).toBe("Error message");
  });

  it("strips multiple ANSI codes in sequence", () => {
    const input = "\x1b[1;32mSuccess\x1b[0m \x1b[34mInfo\x1b[0m";
    expect(stripAnsi(input)).toBe("Success Info");
  });

  it("strips OSC (Operating System Command) sequences", () => {
    const input = "\x1b]0;Window Title\x07Text here";
    expect(stripAnsi(input)).toBe("Text here");
  });

  it("strips mixed ANSI and OSC codes", () => {
    const input = "\x1b]0;Title\x07\x1b[31mRed text\x1b[0m";
    expect(stripAnsi(input)).toBe("Red text");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles string with no ANSI codes", () => {
    expect(stripAnsi("Plain text")).toBe("Plain text");
  });

  it("handles multi-line output with ANSI codes", () => {
    const input = "\x1b[32mLine 1\x1b[0m\n\x1b[33mLine 2\x1b[0m\n\x1b[34mLine 3\x1b[0m";
    expect(stripAnsi(input)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("removes CSI cursor movement codes", () => {
    const input = "Text\x1b[2K\x1b[1GMore text";
    expect(stripAnsi(input)).toBe("TextMore text");
  });

  it("removes bold, underline, and other style codes", () => {
    const input = "\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m";
    expect(stripAnsi(input)).toBe("Bold Underline");
  });
});

describe("parseCredits", () => {
  it("extracts credit value from stderr", () => {
    const stderr = "Credits: 0.04 • Time: 1s";
    expect(parseCredits(stderr)).toBe(0.04);
  });

  it("extracts credit value with comma separator", () => {
    const stderr = "Credits: 1,234.56 • Time: 10s";
    expect(parseCredits(stderr)).toBe(1234.56);
  });

  it("returns null when no credit info present", () => {
    const stderr = "Some other output";
    expect(parseCredits(stderr)).toBeNull();
  });

  it("handles empty stderr", () => {
    expect(parseCredits("")).toBeNull();
  });

  it("extracts from multi-line stderr", () => {
    const stderr = "Processing...\nCredits: 0.15 • Time: 2s\nDone";
    expect(parseCredits(stderr)).toBe(0.15);
  });

  it("is case-insensitive for 'Credits' keyword", () => {
    expect(parseCredits("credits: 0.50 • Time: 1s")).toBe(0.50);
    expect(parseCredits("CREDITS: 0.75 • Time: 1s")).toBe(0.75);
  });

  it("handles integer values", () => {
    const stderr = "Credits: 5 • Time: 1s";
    expect(parseCredits(stderr)).toBe(5);
  });
});

describe("parseTimeSeconds", () => {
  it("extracts time value from stderr", () => {
    const stderr = "Credits: 0.04 • Time: 1s";
    expect(parseTimeSeconds(stderr)).toBe(1);
  });

  it("extracts decimal time values", () => {
    const stderr = "Credits: 0.04 • Time: 2.5s";
    expect(parseTimeSeconds(stderr)).toBe(2.5);
  });

  it("extracts time with comma separator", () => {
    const stderr = "Credits: 0.04 • Time: 1,234.5s";
    expect(parseTimeSeconds(stderr)).toBe(1234.5);
  });

  it("returns null when no time info present", () => {
    const stderr = "Some other output";
    expect(parseTimeSeconds(stderr)).toBeNull();
  });

  it("handles empty stderr", () => {
    expect(parseTimeSeconds("")).toBeNull();
  });

  it("is case-insensitive for 'Time' keyword", () => {
    expect(parseTimeSeconds("Credits: 0.04 • time: 10s")).toBe(10);
    expect(parseTimeSeconds("Credits: 0.04 • TIME: 20s")).toBe(20);
  });
});

describe("parseKiroOutput", () => {
  it("strips ANSI codes from stdout and returns summary", () => {
    const stdout = "\x1b[32mResponse text\x1b[0m";
    const stderr = "";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.summary).toBe("Response text");
  });

  it("extracts costUsd from stderr", () => {
    const stdout = "Response";
    const stderr = "Credits: 0.04 • Time: 1s";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.costUsd).toBe(0.04);
  });

  it("extracts timeSeconds from stderr", () => {
    const stdout = "Response";
    const stderr = "Credits: 0.04 • Time: 5s";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.timeSeconds).toBe(5);
  });

  it("returns null for costUsd when not present", () => {
    const stdout = "Response";
    const stderr = "No credit info here";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.costUsd).toBeNull();
  });

  it("returns null for timeSeconds when not present", () => {
    const stdout = "Response";
    const stderr = "No time info here";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.timeSeconds).toBeNull();
  });

  it("trims whitespace from summary", () => {
    const stdout = "  \x1b[32mResponse text\x1b[0m  ";
    const stderr = "";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.summary).toBe("Response text");
  });

  it("handles empty stdout and stderr", () => {
    const result = parseKiroOutput("", "");
    expect(result.summary).toBe("");
    expect(result.costUsd).toBeNull();
    expect(result.timeSeconds).toBeNull();
  });

  it("extracts both credits and time when present", () => {
    const stdout = "\x1b[1mComplete\x1b[0m";
    const stderr = "Credits: 1.23 • Time: 15.7s";
    const result = parseKiroOutput(stdout, stderr);
    expect(result.summary).toBe("Complete");
    expect(result.costUsd).toBe(1.23);
    expect(result.timeSeconds).toBe(15.7);
  });
});

describe("isKiroUnknownSessionError", () => {
  it("detects 'unknown session' error", () => {
    expect(isKiroUnknownSessionError("", "Error: unknown session id")).toBe(true);
    expect(isKiroUnknownSessionError("unknown session", "")).toBe(true);
  });

  it("detects 'session not found' error", () => {
    expect(isKiroUnknownSessionError("", "session abc123 not found")).toBe(true);
    expect(isKiroUnknownSessionError("", "Session xyz not found")).toBe(true);
  });

  it("detects 'unknown chat' error", () => {
    expect(isKiroUnknownSessionError("", "Error: unknown chat id")).toBe(true);
  });

  it("detects 'chat not found' error", () => {
    expect(isKiroUnknownSessionError("", "chat abc123 not found")).toBe(true);
  });

  it("detects 'resume not found' error", () => {
    expect(isKiroUnknownSessionError("", "resume session not found")).toBe(true);
  });

  it("detects 'could not resume' error", () => {
    expect(isKiroUnknownSessionError("", "could not resume session")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKiroUnknownSessionError("", "UNKNOWN SESSION")).toBe(true);
    expect(isKiroUnknownSessionError("", "SESSION XYZ NOT FOUND")).toBe(true);
  });

  it("checks both stdout and stderr", () => {
    expect(isKiroUnknownSessionError("unknown session", "")).toBe(true);
    expect(isKiroUnknownSessionError("", "unknown session")).toBe(true);
    expect(isKiroUnknownSessionError("normal output", "unknown session")).toBe(true);
  });

  it("strips ANSI codes before checking", () => {
    const ansiError = "\x1b[31mError: unknown session\x1b[0m";
    expect(isKiroUnknownSessionError(ansiError, "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isKiroUnknownSessionError("Processing complete", "Done")).toBe(false);
    expect(isKiroUnknownSessionError("", "")).toBe(false);
  });

  it("returns false for other errors", () => {
    expect(isKiroUnknownSessionError("", "Authentication failed")).toBe(false);
    expect(isKiroUnknownSessionError("", "Network error")).toBe(false);
  });

  it("handles multi-line output", () => {
    const output = "Processing...\nError: session abc123 not found\nStack trace...";
    expect(isKiroUnknownSessionError(output, "")).toBe(true);
  });
});
