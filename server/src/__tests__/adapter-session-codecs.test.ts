import { describe, expect, it } from "vitest";
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";
import { sessionCodec as codexSessionCodec, isCodexUnknownSessionError } from "@paperclipai/adapter-codex-local/server";
import {
  sessionCodec as cursorSessionCodec,
  isCursorUnknownSessionError,
} from "@paperclipai/adapter-cursor-local/server";
import {
  sessionCodec as opencodeSessionCodec,
  isOpenCodeUnknownSessionError,
} from "@paperclipai/adapter-opencode-local/server";

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
