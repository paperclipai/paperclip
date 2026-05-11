import { describe, expect, it } from "vitest";
import {
  detectCopilotAuthRequired,
  isCopilotUnknownSessionError,
  parseCopilotJsonl,
} from "../adapters/copilot-local/parse.js";

describe("parseCopilotJsonl", () => {
  it("parses session, model, assistant text, and output tokens", () => {
    const stdout = [
      JSON.stringify({ type: "session.tools_updated", data: { model: "gpt-5.4-mini" } }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "hello", outputTokens: 12, phase: "final_answer" },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_123",
        exitCode: 0,
        usage: { premiumRequests: 0.33 },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("sess_123");
    expect(parsed.model).toBe("gpt-5.4-mini");
    expect(parsed.summary).toBe("hello");
    expect(parsed.outputTokens).toBe(12);
    expect(parsed.premiumRequests).toBe(0.33);
  });

  it("captures tool execution failures", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          success: false,
          result: {
            content: "tool failed",
          },
        },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.errorMessage).toBe("tool failed");
  });
});

describe("isCopilotUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isCopilotUnknownSessionError("session not found", "")).toBe(true);
    expect(isCopilotUnknownSessionError("", "failed to resume session")).toBe(true);
    expect(isCopilotUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("detectCopilotAuthRequired", () => {
  it("detects login and subscription failures", () => {
    expect(detectCopilotAuthRequired({ stdout: "Run /login first", stderr: "" }).requiresAuth).toBe(true);
    expect(
      detectCopilotAuthRequired({ stdout: "", stderr: "Active Copilot subscription required" }).requiresAuth,
    ).toBe(true);
    expect(detectCopilotAuthRequired({ stdout: "hello", stderr: "" }).requiresAuth).toBe(false);
  });
});
