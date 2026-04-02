import { describe, expect, it } from "vitest";
import { sessionCodec as claudeSessionCodec } from "@penclipai/adapter-claude-local/server";
import {
  sessionCodec as codeBuddySessionCodec,
  isCodeBuddyUnknownSessionError,
} from "@penclipai/adapter-codebuddy-local/server";
import { sessionCodec as codexSessionCodec, isCodexUnknownSessionError } from "@penclipai/adapter-codex-local/server";
import {
  sessionCodec as cursorSessionCodec,
  isCursorUnknownSessionError,
} from "@penclipai/adapter-cursor-local/server";
import {
  sessionCodec as geminiSessionCodec,
  isGeminiUnknownSessionError,
} from "@penclipai/adapter-gemini-local/server";
import {
  sessionCodec as opencodeSessionCodec,
  isOpenCodeUnknownSessionError,
} from "@penclipai/adapter-opencode-local/server";

describe("adapter session codecs", () => {
  it("normalizes claude session params with cwd", () => {
    const parsed = claudeSessionCodec.deserialize({
      session_id: "claude-session-1",
      folder: "/tmp/workspace",
    });
    expect(parsed).toEqual({
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
    });

    const serialized = claudeSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
    });
    expect(claudeSessionCodec.getDisplayId?.(serialized ?? null)).toBe("claude-session-1");
  });

  it("normalizes codex session params with cwd", () => {
    const parsed = codexSessionCodec.deserialize({
      sessionId: "codex-session-1",
      cwd: "/tmp/codex",
    });
    expect(parsed).toEqual({
      sessionId: "codex-session-1",
      cwd: "/tmp/codex",
    });

    const serialized = codexSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "codex-session-1",
      cwd: "/tmp/codex",
    });
    expect(codexSessionCodec.getDisplayId?.(serialized ?? null)).toBe("codex-session-1");
  });

  it("normalizes codebuddy session params with cwd", () => {
    const parsed = codeBuddySessionCodec.deserialize({
      session_id: "codebuddy-session-1",
      cwd: "/tmp/codebuddy",
    });
    expect(parsed).toEqual({
      sessionId: "codebuddy-session-1",
      cwd: "/tmp/codebuddy",
    });

    const serialized = codeBuddySessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "codebuddy-session-1",
      cwd: "/tmp/codebuddy",
    });
    expect(codeBuddySessionCodec.getDisplayId?.(serialized ?? null)).toBe("codebuddy-session-1");
  });

  it("normalizes opencode session params with cwd", () => {
    const parsed = opencodeSessionCodec.deserialize({
      sessionID: "opencode-session-1",
      cwd: "/tmp/opencode",
    });
    expect(parsed).toEqual({
      sessionId: "opencode-session-1",
      cwd: "/tmp/opencode",
    });

    const serialized = opencodeSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "opencode-session-1",
      cwd: "/tmp/opencode",
    });
    expect(opencodeSessionCodec.getDisplayId?.(serialized ?? null)).toBe("opencode-session-1");
  });

  it("normalizes cursor session params with cwd", () => {
    const parsed = cursorSessionCodec.deserialize({
      session_id: "cursor-session-1",
      cwd: "/tmp/cursor",
    });
    expect(parsed).toEqual({
      sessionId: "cursor-session-1",
      cwd: "/tmp/cursor",
    });

    const serialized = cursorSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "cursor-session-1",
      cwd: "/tmp/cursor",
    });
    expect(cursorSessionCodec.getDisplayId?.(serialized ?? null)).toBe("cursor-session-1");
  });

  it("normalizes gemini session params with cwd", () => {
    const parsed = geminiSessionCodec.deserialize({
      session_id: "gemini-session-1",
      cwd: "/tmp/gemini",
    });
    expect(parsed).toEqual({
      sessionId: "gemini-session-1",
      cwd: "/tmp/gemini",
    });

    const serialized = geminiSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "gemini-session-1",
      cwd: "/tmp/gemini",
    });
    expect(geminiSessionCodec.getDisplayId?.(serialized ?? null)).toBe("gemini-session-1");
  });
});

describe("codebuddy resume recovery detection", () => {
  it("detects unknown session errors from codebuddy output", () => {
    expect(
      isCodeBuddyUnknownSessionError(
        "{\"type\":\"error\",\"message\":\"No conversation found with session ID: stale-session\"}",
        "",
      ),
    ).toBe(true);
    expect(
      isCodeBuddyUnknownSessionError(
        "",
        "resume session not found",
      ),
    ).toBe(true);
    expect(
      isCodeBuddyUnknownSessionError(
        "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\"}",
        "",
      ),
    ).toBe(false);
  });
});

describe("codex resume recovery detection", () => {
  it("detects unknown session errors from codex output", () => {
    expect(
      isCodexUnknownSessionError(
        '{"type":"error","message":"Unknown session id abc"}',
        "",
      ),
    ).toBe(true);
    expect(
      isCodexUnknownSessionError(
        "",
        "thread 123 not found",
      ),
    ).toBe(true);
    expect(
      isCodexUnknownSessionError(
        '{"type":"result","ok":true}',
        "",
      ),
    ).toBe(false);
  });
});

describe("opencode resume recovery detection", () => {
  it("detects unknown session errors from opencode output", () => {
    expect(
      isOpenCodeUnknownSessionError(
        "",
        "NotFoundError: Resource not found: /Users/test/.local/share/opencode/storage/session/proj/ses_missing.json",
      ),
    ).toBe(true);
    expect(
      isOpenCodeUnknownSessionError(
        "{\"type\":\"step_finish\",\"part\":{\"reason\":\"stop\"}}",
        "",
      ),
    ).toBe(false);
  });
});

describe("cursor resume recovery detection", () => {
  it("detects unknown session errors from cursor output", () => {
    expect(
      isCursorUnknownSessionError(
        "",
        "Error: unknown session id abc",
      ),
    ).toBe(true);
    expect(
      isCursorUnknownSessionError(
        "",
        "chat abc not found",
      ),
    ).toBe(true);
    expect(
      isCursorUnknownSessionError(
        "{\"type\":\"result\",\"subtype\":\"success\"}",
        "",
      ),
    ).toBe(false);
  });
});

describe("gemini resume recovery detection", () => {
  it("detects unknown session errors from gemini output", () => {
    expect(
      isGeminiUnknownSessionError(
        "",
        "unknown session id abc",
      ),
    ).toBe(true);
    expect(
      isGeminiUnknownSessionError(
        "",
        "checkpoint latest not found",
      ),
    ).toBe(true);
    expect(
      isGeminiUnknownSessionError(
        "{\"type\":\"result\",\"subtype\":\"success\"}",
        "",
      ),
    ).toBe(false);
  });
});
