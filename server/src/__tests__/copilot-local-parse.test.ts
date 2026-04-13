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

  it("captures session errors such as Copilot rate limits", () => {
    const stdout = [
      JSON.stringify({
        type: "session.mcp_server_status_changed",
        data: { serverName: "github-mcp-server", status: "connected" },
      }),
      JSON.stringify({
        type: "session.error",
        data: {
          errorType: "rate_limit",
          message: "Sorry, you've hit a rate limit. Please try again in 1 minute.",
          statusCode: 429,
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_rate_limit",
        exitCode: 1,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("sess_rate_limit");
    expect(parsed.errorType).toBe("rate_limit");
    expect(parsed.statusCode).toBe(429);
    expect(parsed.isRateLimit).toBe(true);
    expect(parsed.errorMessage).toBe("Sorry, you've hit a rate limit. Please try again in 1 minute.");
  });

  it("turns dangerous shell command refusals into approval-needed handoffs when Copilot asks for approval", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          success: false,
          result: {
            content:
              "Command blocked: contains dangerous shell expansion patterns (e.g., parameter transformation, indirect expansion, or nested command substitution) that could enable arbitrary code execution.",
          },
        },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          content:
            "**Approval needed:** allow execution of the blocked shell command?\n\nReply **approve** to allow it, or **deny** to block it.",
          outputTokens: 27,
          phase: "final_answer",
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_approval",
        exitCode: 0,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("sess_approval");
    expect(parsed.approvalRequired).toBe(true);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toContain("Approval needed");
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
