import { describe, it, expect } from "vitest";
import { parseVibeStream, detectVibeAuthRequired } from "./parse.js";

describe("parseVibeStream", () => {
  it("extracts final assistant message", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "assistant", content: "Task complete." }),
    ].join("\n");
    const result = parseVibeStream(stdout);
    expect(result.finalMessage).toBe("Task complete.");
    expect(result.errors).toHaveLength(0);
  });

  it("counts tool calls", () => {
    const stdout = [
      JSON.stringify({ type: "tool_call", name: "bash", input: {} }),
      JSON.stringify({ type: "tool_call", name: "read", input: {} }),
      JSON.stringify({ type: "message", role: "assistant", content: "Done." }),
    ].join("\n");
    const result = parseVibeStream(stdout);
    expect(result.toolCallCount).toBe(2);
  });

  it("collects error events", () => {
    const stdout = JSON.stringify({ type: "error", message: "Rate limit exceeded" });
    const result = parseVibeStream(stdout);
    expect(result.errors).toContain("Rate limit exceeded");
  });

  it("ignores non-JSON lines", () => {
    const stdout = "Vibe CLI v2.16.1\n" + JSON.stringify({ type: "message", role: "assistant", content: "Hi." });
    const result = parseVibeStream(stdout);
    expect(result.finalMessage).toBe("Hi.");
  });

  it("returns null finalMessage when no assistant message found", () => {
    const stdout = JSON.stringify({ type: "tool_call", name: "bash", input: {} });
    const result = parseVibeStream(stdout);
    expect(result.finalMessage).toBeNull();
  });

  it("returns null finalMessage for empty stdout", () => {
    expect(parseVibeStream("").finalMessage).toBeNull();
  });
});

describe("detectVibeAuthRequired", () => {
  it("detects 'not authenticated'", () => {
    expect(detectVibeAuthRequired("", "Error: not authenticated")).toBe(true);
  });

  it("detects 'invalid api key'", () => {
    expect(detectVibeAuthRequired("", "invalid api key provided")).toBe(true);
  });

  it("detects 'vibe --setup' suggestion", () => {
    expect(detectVibeAuthRequired("", "Run vibe --setup to configure your account")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(detectVibeAuthRequired("Task done.", "")).toBe(false);
  });
});
