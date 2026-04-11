import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("copilot sessionCodec", () => {
  it("round-trips session params", () => {
    const params = {
      sessionId: "sess_123",
      cwd: "/tmp/work",
      workspaceId: "ws_1",
      repoUrl: "https://github.com/example/repo",
      repoRef: "main",
    };

    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);
    expect(sessionCodec.deserialize(serialized)).toEqual(params);
    expect(sessionCodec.getDisplayId?.(serialized)).toBe("sess_123");
  });

  it("rejects missing session ids", () => {
    expect(sessionCodec.serialize({ cwd: "/tmp/work" })).toBeNull();
    expect(sessionCodec.deserialize({ cwd: "/tmp/work" })).toBeNull();
  });
});
