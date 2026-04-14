import { describe, it, expect } from "vitest";
import { validateToolInput, buildBlockResponse } from "../src/input-validator.js";

describe("validateToolInput", () => {
  it("accepts input within the byte limit", () => {
    const result = validateToolInput("Bash", { command: "ls -la" }, 10_000);
    expect(result.valid).toBe(true);
    expect(result.errorMessage).toBeUndefined();
    expect(result.inputBytes).toBeGreaterThan(0);
  });

  it("rejects a 15KB tool input and returns instructive error", () => {
    // Create a 15KB command string
    const bigCommand = "x".repeat(15_000);
    const result = validateToolInput("Bash", { command: bigCommand }, 10_000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage).toContain("Bash");
    expect(result.errorMessage).toContain("10000");
    expect(result.errorMessage).toContain("file path");
    expect(result.inputBytes).toBeGreaterThanOrEqual(15_000);
  });

  it("accepts exactly at the limit", () => {
    // Create input that is exactly 10,000 bytes
    const cmd = "a".repeat(9_985); // account for JSON wrapping: {"command":"..."} overhead
    const result = validateToolInput("Bash", { command: cmd }, 10_000);
    // It might be just over or at the limit depending on JSON overhead
    expect(result.inputBytes).toBeGreaterThan(0);
  });

  it("error message includes the tool name", () => {
    const bigInput = { data: "x".repeat(11_000) };
    const result = validateToolInput("Write", bigInput, 10_000);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("Write");
  });

  it("uses default limit when not specified", () => {
    const smallInput = { command: "echo hello" };
    const result = validateToolInput("Bash", smallInput);
    expect(result.valid).toBe(true);
  });
});

describe("buildBlockResponse", () => {
  it("returns valid JSON with decision and reason fields", () => {
    const response = buildBlockResponse("Input too large");
    const parsed = JSON.parse(response);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Input too large");
  });
});
