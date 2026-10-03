import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("agy-local sessionCodec", () => {
  it("deserializes sessionId and cwd", () => {
    const parsed = sessionCodec.deserialize({
      sessionId: "conv-123",
      cwd: "/tmp/workspace",
    });
    expect(parsed).toEqual({
      sessionId: "conv-123",
      cwd: "/tmp/workspace",
    });
  });

  it("deserializes conversationId for backward compatibility", () => {
    const parsed = sessionCodec.deserialize({
      conversationId: "conv-456",
      cwd: "/tmp/workspace",
    });
    expect(parsed).toEqual({
      sessionId: "conv-456",
      cwd: "/tmp/workspace",
    });
  });

  it("deserializes snake_case session_id and conversation_id", () => {
    expect(sessionCodec.deserialize({ session_id: "conv-789" })).toEqual({
      sessionId: "conv-789",
    });
    expect(sessionCodec.deserialize({ conversation_id: "conv-abc" })).toEqual({
      sessionId: "conv-abc",
    });
  });

  it("serializes to standard sessionId shape", () => {
    const serialized = sessionCodec.serialize({
      sessionId: "conv-123",
      cwd: "/tmp/workspace",
    });
    expect(serialized).toEqual({
      sessionId: "conv-123",
      cwd: "/tmp/workspace",
    });
    expect(sessionCodec.getDisplayId?.(serialized ?? null)).toBe("conv-123");
  });

  it("serializes conversationId to sessionId shape", () => {
    const serialized = sessionCodec.serialize({
      conversationId: "conv-456",
    });
    expect(serialized).toEqual({
      sessionId: "conv-456",
    });
    expect(sessionCodec.getDisplayId?.(serialized ?? null)).toBe("conv-456");
  });

  it("preserves remoteExecution in session params", () => {
    const parsed = sessionCodec.deserialize({
      sessionId: "conv-remote-1",
      cwd: "/tmp/workspace",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/example/repo.git",
      repoRef: "main",
      remoteExecution: {
        environmentId: "env-1",
        leaseId: "lease-1",
      },
    });
    expect(parsed).toEqual({
      sessionId: "conv-remote-1",
      cwd: "/tmp/workspace",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/example/repo.git",
      repoRef: "main",
      remoteExecution: {
        environmentId: "env-1",
        leaseId: "lease-1",
      },
    });

    const serialized = sessionCodec.serialize(parsed);
    expect(serialized).toEqual(parsed);
  });

  it("returns null for empty or invalid params", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.serialize({})).toBeNull();
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
    expect(sessionCodec.getDisplayId?.({})).toBeNull();
  });
});
