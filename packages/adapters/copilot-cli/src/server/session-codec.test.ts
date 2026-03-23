import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import { isCopilotUnknownSessionError } from "./parse.js";

// ─── sessionCodec.deserialize ─────────────────────────────────────────────────

describe("sessionCodec.deserialize", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(sessionCodec.deserialize("string")).toBeNull();
    expect(sessionCodec.deserialize(42)).toBeNull();
    expect(sessionCodec.deserialize(true)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(sessionCodec.deserialize(["a", "b"])).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    expect(sessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
  });

  it("returns null when sessionId is empty string", () => {
    expect(sessionCodec.deserialize({ sessionId: "" })).toBeNull();
  });

  it("returns null when sessionId is whitespace-only", () => {
    expect(sessionCodec.deserialize({ sessionId: "   " })).toBeNull();
  });

  it("extracts sessionId from sessionId field", () => {
    const result = sessionCodec.deserialize({ sessionId: "abc-123" });
    expect(result).toEqual({ sessionId: "abc-123" });
  });

  it("extracts sessionId from session_id field (snake_case fallback)", () => {
    const result = sessionCodec.deserialize({ session_id: "def-456" });
    expect(result).toEqual({ sessionId: "def-456" });
  });

  it("prefers sessionId over session_id", () => {
    const result = sessionCodec.deserialize({
      sessionId: "camel",
      session_id: "snake",
    });
    expect(result).toEqual({ sessionId: "camel" });
  });

  it("includes cwd when present", () => {
    const result = sessionCodec.deserialize({
      sessionId: "s1",
      cwd: "/home/user/project",
    });
    expect(result).toEqual({ sessionId: "s1", cwd: "/home/user/project" });
  });

  it("falls back to workdir for cwd", () => {
    const result = sessionCodec.deserialize({
      sessionId: "s1",
      workdir: "/tmp/work",
    });
    expect(result).toEqual({ sessionId: "s1", cwd: "/tmp/work" });
  });

  it("falls back to folder for cwd", () => {
    const result = sessionCodec.deserialize({
      sessionId: "s1",
      folder: "/opt/project",
    });
    expect(result).toEqual({ sessionId: "s1", cwd: "/opt/project" });
  });

  it("includes optional workspace fields", () => {
    const result = sessionCodec.deserialize({
      sessionId: "s1",
      cwd: "/tmp",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
    expect(result).toEqual({
      sessionId: "s1",
      cwd: "/tmp",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
  });

  it("reads snake_case workspace fields", () => {
    const result = sessionCodec.deserialize({
      session_id: "s1",
      workspace_id: "ws-2",
      repo_url: "https://github.com/org/repo2",
      repo_ref: "develop",
    });
    expect(result).toEqual({
      sessionId: "s1",
      workspaceId: "ws-2",
      repoUrl: "https://github.com/org/repo2",
      repoRef: "develop",
    });
  });

  it("trims whitespace from values", () => {
    const result = sessionCodec.deserialize({
      sessionId: "  s1  ",
      cwd: "  /tmp  ",
    });
    expect(result).toEqual({ sessionId: "s1", cwd: "/tmp" });
  });
});

// ─── sessionCodec.serialize ───────────────────────────────────────────────────

describe("sessionCodec.serialize", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    expect(sessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
  });

  it("returns null when sessionId is empty", () => {
    expect(sessionCodec.serialize({ sessionId: "" })).toBeNull();
  });

  it("serializes sessionId only", () => {
    expect(sessionCodec.serialize({ sessionId: "s1" })).toEqual({
      sessionId: "s1",
    });
  });

  it("serializes all fields", () => {
    const input = {
      sessionId: "s1",
      cwd: "/tmp",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    };
    expect(sessionCodec.serialize(input)).toEqual(input);
  });
});

// ─── sessionCodec round-trip ──────────────────────────────────────────────────

describe("sessionCodec round-trip", () => {
  it("round-trips full params through serialize → deserialize", () => {
    const original = {
      sessionId: "abc-123",
      cwd: "/home/user/project",
      workspaceId: "ws-42",
      repoUrl: "https://github.com/org/repo",
      repoRef: "feature-branch",
    };
    const serialized = sessionCodec.serialize(original);
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(original);
  });

  it("round-trips minimal params (sessionId only)", () => {
    const original = { sessionId: "minimal-session" };
    const serialized = sessionCodec.serialize(original);
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(original);
  });
});

// ─── sessionCodec.getDisplayId ────────────────────────────────────────────────

describe("sessionCodec.getDisplayId", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.getDisplayId!(null)).toBeNull();
  });

  it("returns sessionId", () => {
    expect(sessionCodec.getDisplayId!({ sessionId: "display-id" })).toBe("display-id");
  });

  it("returns session_id as fallback", () => {
    expect(sessionCodec.getDisplayId!({ session_id: "snake-id" })).toBe("snake-id");
  });

  it("returns null when no session id field", () => {
    expect(sessionCodec.getDisplayId!({ cwd: "/tmp" })).toBeNull();
  });
});

// ─── isCopilotUnknownSessionError ─────────────────────────────────────────────

describe("isCopilotUnknownSessionError", () => {
  it("returns false for normal success result", () => {
    expect(isCopilotUnknownSessionError({ exitCode: 0 })).toBe(false);
  });

  it("detects 'unknown session' error", () => {
    expect(
      isCopilotUnknownSessionError({ error: "unknown session abc-123" }),
    ).toBe(true);
  });

  it("detects 'session not found' error", () => {
    expect(
      isCopilotUnknownSessionError({ error: "session not found" }),
    ).toBe(true);
  });

  it("detects 'session expired' error", () => {
    expect(
      isCopilotUnknownSessionError({ error: "session expired" }),
    ).toBe(true);
  });

  it("detects 'invalid session' error", () => {
    expect(
      isCopilotUnknownSessionError({ error: "invalid session id" }),
    ).toBe(true);
  });

  it("detects 'session invalid' error", () => {
    expect(
      isCopilotUnknownSessionError({ error: "the session invalid for this request" }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isCopilotUnknownSessionError({ error: "network timeout" }),
    ).toBe(false);
  });

  it("detects errors in nested result objects", () => {
    expect(
      isCopilotUnknownSessionError({
        exitCode: 1,
        data: { message: "Session not found for ID abc" },
      }),
    ).toBe(true);
  });
});
