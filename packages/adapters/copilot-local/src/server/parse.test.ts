import { describe, expect, it } from "vitest";
import { parseCopilotJsonl, isCopilotUnknownSessionError, isCopilotAuthError } from "./parse.js";

describe("parseCopilotJsonl", () => {
  it("parses sessionId and model from result and tools_updated events", () => {
    const stdout = [
      JSON.stringify({ type: "session.tools_updated", data: { model: "claude-sonnet-4.6" }, ephemeral: true }),
      JSON.stringify({ type: "result", sessionId: "abc-123", exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 1500, sessionDurationMs: 5000, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.model).toBe("claude-sonnet-4.6");
    expect(parsed.usage.premiumRequests).toBe(1);
    expect(parsed.usage.totalApiDurationMs).toBe(1500);
  });

  it("extracts assistant message content as messages and summary", () => {
    const stdout = [
      JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "Hello world", toolRequests: [], outputTokens: 5 } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "m2", content: "Second message", toolRequests: [], outputTokens: 3 } }),
      JSON.stringify({ type: "result", sessionId: "s1", exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 100, sessionDurationMs: 200, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.messages).toEqual(["Hello world", "Second message"]);
    expect(parsed.summary).toContain("Hello world");
    expect(parsed.summary).toContain("Second message");
  });

  it("skips empty content messages", () => {
    const stdout = [
      JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "t1", name: "view", arguments: {} }], outputTokens: 10 } }),
      JSON.stringify({ type: "result", sessionId: "s1", exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 100, sessionDurationMs: 200, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.messages).toHaveLength(0);
  });

  it("extracts code changes from result usage", () => {
    const stdout = JSON.stringify({
      type: "result",
      sessionId: "s1",
      exitCode: 0,
      usage: { premiumRequests: 1, totalApiDurationMs: 100, sessionDurationMs: 200, codeChanges: { linesAdded: 10, linesRemoved: 3, filesModified: ["a.ts", "b.ts"] } },
    });

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.codeChanges).toEqual({ linesAdded: 10, linesRemoved: 3, filesModified: ["a.ts", "b.ts"] });
  });

  it("handles empty and malformed input gracefully", () => {
    expect(parseCopilotJsonl("").messages).toHaveLength(0);
    expect(parseCopilotJsonl("not json\n{bad").messages).toHaveLength(0);
    expect(parseCopilotJsonl("  \n  \n  ").messages).toHaveLength(0);
  });

  it("returns null sessionId when no result event", () => {
    const stdout = JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "hi", toolRequests: [], outputTokens: 2 } });
    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBeNull();
  });
});

describe("isCopilotUnknownSessionError", () => {
  it("detects known session error patterns", () => {
    expect(isCopilotUnknownSessionError("Session not found: abc")).toBe(true);
    expect(isCopilotUnknownSessionError("unknown session id")).toBe(true);
    expect(isCopilotUnknownSessionError("session does not exist")).toBe(true);
    expect(isCopilotUnknownSessionError("invalid session")).toBe(true);
  });

  it("returns false for unrelated output", () => {
    expect(isCopilotUnknownSessionError("all good")).toBe(false);
    expect(isCopilotUnknownSessionError("session started")).toBe(false);
  });
});

describe("isCopilotAuthError", () => {
  it("detects 'No authentication information found' error", () => {
    expect(isCopilotAuthError("", "No authentication information found")).toBe(true);
  });

  it("detects classic PAT rejection", () => {
    expect(isCopilotAuthError("", "Classic Personal Access Tokens (ghp_) are not supported by Copilot")).toBe(true);
  });

  it("detects copilot login hint", () => {
    expect(isCopilotAuthError("", "run copilot login to authenticate")).toBe(true);
  });

  it("does NOT match unrelated output", () => {
    expect(isCopilotAuthError("task completed", "exit 0")).toBe(false);
    expect(isCopilotAuthError("wrote 401 bytes", "")).toBe(false);
    expect(isCopilotAuthError("authentication middleware loaded", "")).toBe(false);
  });

  it("checks both stdout and stderr", () => {
    expect(isCopilotAuthError("No authentication information found", "")).toBe(true);
    expect(isCopilotAuthError("", "No authentication information found")).toBe(true);
  });

  it("detects 'authenticate with copilot' pattern", () => {
    expect(isCopilotAuthError("", "Please authenticate with copilot first")).toBe(true);
  });
});

describe("parseCopilotJsonl — tool execution", () => {
  it("captures tool execution errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "t1", success: false, result: { content: "Permission denied" } },
      }),
      JSON.stringify({
        type: "result", sessionId: "s1", exitCode: 1,
        usage: { premiumRequests: 1, totalApiDurationMs: 100, sessionDurationMs: 200, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.errors).toContain("Permission denied");
  });

  it("ignores successful tool executions", () => {
    const stdout = JSON.stringify({
      type: "tool.execution_complete",
      data: { toolCallId: "t1", success: true, result: { content: "ok" } },
    });

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.errors).toHaveLength(0);
  });

  it("accumulates messages across multiple turns", () => {
    const stdout = [
      JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "Turn 1 output", toolRequests: [], outputTokens: 5 } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "m2", content: "", toolRequests: [{ name: "view" }], outputTokens: 10 } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "m3", content: "Turn 2 output", toolRequests: [], outputTokens: 8 } }),
      JSON.stringify({ type: "result", sessionId: "s1", exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 3000, sessionDurationMs: 5000, codeChanges: { linesAdded: 5, linesRemoved: 2, filesModified: ["a.ts"] } } }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.messages).toEqual(["Turn 1 output", "Turn 2 output"]);
    expect(parsed.summary).toBe("Turn 1 output\n\nTurn 2 output");
    expect(parsed.codeChanges).toEqual({ linesAdded: 5, linesRemoved: 2, filesModified: ["a.ts"] });
  });
});
