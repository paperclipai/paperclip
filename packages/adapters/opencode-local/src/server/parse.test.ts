import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodePermissionAutoRejectError,
  isOpenCodeStaleWorkspaceFileError,
  isOpenCodeUnknownSessionError,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("isOpenCodePermissionAutoRejectError", () => {
  it("detects stderr auto-reject banner", () => {
    expect(
      isOpenCodePermissionAutoRejectError(
        "",
        "permission requested: external_directory (/tmp/*); auto-rejecting\n",
        null,
      ),
    ).toBe(true);
  });

  it("detects tool_use error text from parsed aggregate", () => {
    expect(
      isOpenCodePermissionAutoRejectError(
        "",
        "",
        "The user rejected permission to use this specific tool call.",
      ),
    ).toBe(true);
  });

  it("ignores unrelated output", () => {
    expect(isOpenCodePermissionAutoRejectError("done", "npm warn", null)).toBe(false);
  });
});

describe("isOpenCodeStaleWorkspaceFileError", () => {
  it("detects OpenCode stale read/write guard on memory files", () => {
    const msg =
      "File `/path/memory/2026-04-04.md` has been modified since it was last read. Please read the file again before modifying it.";
    expect(isOpenCodeStaleWorkspaceFileError("", "", msg)).toBe(true);
    expect(isOpenCodeStaleWorkspaceFileError("", msg, null)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isOpenCodeStaleWorkspaceFileError("", "", "ENOENT: no such file")).toBe(false);
  });
});
