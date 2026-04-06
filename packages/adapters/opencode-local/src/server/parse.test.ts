import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  opencodeStdoutIndicatesIgnorableNonZeroExit,
  isOpenCodePermissionAutoRejectError,
  isOpenCodeStaleWorkspaceFileError,
  isOpenCodeFileNotFoundPathError,
  isOpenCodeToolArgumentValidationError,
  isOpenCodeWebfetchFormatValidationError,
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
    expect(parsed.lastStepFinishReason).toBe("done");
  });

  it("tracks terminal step_finish reason and detects ignorable non-zero exit conditions", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_456",
        part: { text: "Applied patch and left comments." },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_456",
        part: {
          reason: "stop",
          cost: 0.001,
          tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.lastStepFinishReason).toBe("stop");
    expect(opencodeStdoutIndicatesIgnorableNonZeroExit(parsed, "")).toBe(true);
    expect(opencodeStdoutIndicatesIgnorableNonZeroExit(parsed, "warning on stderr")).toBe(false);
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

  it("detects must-read-before-overwrite guard variants", () => {
    const msg =
      "Error: You must read file /Users/nincius/.paperclip/instances/default/workspaces/fdf/memory/2026-04-06.md before overwriting it. Use the Read tool first";
    expect(isOpenCodeStaleWorkspaceFileError("", "", msg)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isOpenCodeStaleWorkspaceFileError("", "", "ENOENT: no such file")).toBe(false);
  });
});

describe("isOpenCodeToolArgumentValidationError", () => {
  it("detects webfetch invalid argument errors", () => {
    expect(
      isOpenCodeToolArgumentValidationError(
        "",
        "",
        "Error: The webfetch tool was called with invalid args: expected object with `url`.",
      ),
    ).toBe(true);
  });

  it("detects generic invalid tool-argument errors", () => {
    expect(
      isOpenCodeToolArgumentValidationError(
        "",
        "invalid arguments for tool read_file",
        null,
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isOpenCodeToolArgumentValidationError("", "", "network timeout")).toBe(false);
  });
});

describe("isOpenCodeWebfetchFormatValidationError", () => {
  it("detects invalid webfetch format option payloads", () => {
    expect(
      isOpenCodeWebfetchFormatValidationError(
        "",
        "",
        "Invalid option: expected one of \"text\"|\"markdown\"|\"html\" at path format (webfetch).",
      ),
    ).toBe(true);
  });

  it("ignores generic tool argument errors when format is not referenced", () => {
    expect(
      isOpenCodeWebfetchFormatValidationError(
        "",
        "",
        "The edit tool was called with invalid arguments: oldString/newString type mismatch.",
      ),
    ).toBe(false);
  });
});

describe("isOpenCodeFileNotFoundPathError", () => {
  it("detects explicit file not found errors", () => {
    expect(
      isOpenCodeFileNotFoundPathError(
        "",
        "",
        "Error: File not found: /Users/nincius/sistematecnica-v1/supabase/functions/_shared/studioFusion.ts",
      ),
    ).toBe(true);
  });

  it("detects ENOENT/no-such-file variants", () => {
    expect(
      isOpenCodeFileNotFoundPathError(
        "",
        "",
        "ENOENT: no such file or directory, open './missing.ts'",
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isOpenCodeFileNotFoundPathError("", "", "network timeout")).toBe(false);
  });
});
