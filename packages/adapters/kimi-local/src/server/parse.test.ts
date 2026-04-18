import { describe, expect, it } from "vitest";
import {
  parseKimiStreamJson,
  isKimiUnknownSessionError,
  isKimiMaxStepsError,
  detectKimiLoginRequired,
} from "./parse.js";

describe("parseKimiStreamJson", () => {
  it("captures session id, model, usage, cost, and summary from stream output", () => {
    const stdout = [
      JSON.stringify({ role: "system", type: "init", model: "kimi-k2-0713", session_id: "sess_abc123" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "I'll help you with that task." }],
      }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "think", think: "Let me analyze the requirements." },
          { type: "tool_use", name: "bash", id: "tool_1", input: { command: "ls -la" } },
        ],
      }),
      JSON.stringify({
        type: "result",
        done: true,
        model: "kimi-k2-0713",
        session_id: "sess_abc123",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        total_cost_usd: 0.0025,
      }),
    ].join("\n");

    const result = parseKimiStreamJson(stdout);

    expect(result.sessionId).toBe("sess_abc123");
    expect(result.model).toBe("kimi-k2-0713");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
    });
    expect(result.costUsd).toBe(0.0025);
    expect(result.summary).toContain("I'll help you with that task.");
    expect(result.summary).toContain("[Thinking] Let me analyze the requirements.");
    expect(result.summary).toContain('[Tool: bash] {"command":"ls -la"}');
  });

  it("returns null values when parsing empty output", () => {
    const result = parseKimiStreamJson("");

    expect(result.sessionId).toBeNull();
    expect(result.model).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.summary).toBe("");
    expect(result.resultJson).toBeNull();
  });

  it("ignores invalid JSON lines and continues parsing", () => {
    const stdout = [
      "not valid json",
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Hello" }] }),
      "{ incomplete",
      JSON.stringify({ type: "result", done: true, usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");

    const result = parseKimiStreamJson(stdout);

    expect(result.summary).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
    });
  });
});

describe("isKimiUnknownSessionError", () => {
  it("detects session not found errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "Session not found",
      }),
    ).toBe(true);

    expect(
      isKimiUnknownSessionError({
        error: "Unknown session id",
      }),
    ).toBe(true);

    expect(
      isKimiUnknownSessionError({
        errors: [{ message: "Invalid session" }],
      }),
    ).toBe(true);
  });

  it("detects Chinese session not found errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "会话不存在",
      }),
    ).toBe(true);
  });

  it("returns false for non-session errors", () => {
    expect(
      isKimiUnknownSessionError({
        result: "Model overloaded",
      }),
    ).toBe(false);

    expect(
      isKimiUnknownSessionError({
        error: "Authentication failed",
      }),
    ).toBe(false);
  });
});

describe("isKimiMaxStepsError", () => {
  it("detects max steps exhaustion in result text", () => {
    expect(
      isKimiMaxStepsError({
        result: "Reached max steps limit",
      }),
    ).toBe(true);

    expect(
      isKimiMaxStepsError({
        result: "Maximum steps exceeded",
      }),
    ).toBe(true);
  });

  it("detects max steps in error messages", () => {
    expect(
      isKimiMaxStepsError({
        errors: [{ message: "Max steps reached" }],
      }),
    ).toBe(true);
  });

  it("returns false for non-max-steps errors", () => {
    expect(
      isKimiMaxStepsError({
        result: "Some other error",
      }),
    ).toBe(false);
  });
});

describe("detectKimiLoginRequired", () => {
  it("detects login required from stdout", () => {
    const result = detectKimiLoginRequired({
      parsed: null,
      stdout: "Please log in to continue",
      stderr: "",
    });

    expect(result.requiresLogin).toBe(true);
    expect(result.loginUrl).toBeNull();
  });

  it("detects login required from stderr", () => {
    const result = detectKimiLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Error: not logged in",
    });

    expect(result.requiresLogin).toBe(true);
  });

  it("detects unauthorized errors", () => {
    const result = detectKimiLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Unauthorized: authentication required",
    });

    expect(result.requiresLogin).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    const result = detectKimiLoginRequired({
      parsed: null,
      stdout: "Success",
      stderr: "Some warning",
    });

    expect(result.requiresLogin).toBe(false);
  });
});
