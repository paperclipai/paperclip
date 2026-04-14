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

  it("captures tool execution failures as lastToolError", () => {
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
    expect(parsed.lastToolError).toBe("tool failed");
    expect(parsed.errorMessage).toBeNull();
  });

  it("does not promote tool errors to errorMessage when run succeeds", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: { success: false, result: { content: "Parent directory does not exist" } },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "I'll create the directory first.", outputTokens: 10, phase: "final_answer" },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_ok",
        exitCode: 0,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.lastToolError).toBe("Parent directory does not exist");
    expect(parsed.summary).toContain("create the directory");
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

  it("sets isDangerousShellBlock when a dangerous shell command is blocked", () => {
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
          content: "I'll rewrite that command to avoid dangerous patterns.",
          outputTokens: 15,
          phase: "final_answer",
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_blocked",
        exitCode: 0,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("sess_blocked");
    expect(parsed.isDangerousShellBlock).toBe(true);
    expect(parsed.errorMessage).toContain("Command blocked");
  });

  it("sets isDangerousShellBlock false when no dangerous pattern is detected", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          success: false,
          result: { content: "some normal error" },
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "sess_normal",
        exitCode: 1,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.isDangerousShellBlock).toBe(false);
    expect(parsed.lastToolError).toBe("some normal error");
    expect(parsed.errorMessage).toBeNull();
  });

  it("session errors take priority over tool errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: { success: false, result: { content: "tool-level failure" } },
      }),
      JSON.stringify({
        type: "session.error",
        data: { message: "session-level failure", errorType: "server_error", statusCode: 500 },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.errorMessage).toBe("session-level failure");
    expect(parsed.lastToolError).toBe("tool-level failure");
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
