import { describe, expect, it } from "vitest";
import { sessionCodec } from "./session.js";

describe("qoderCloudAgents sessionCodec", () => {
  it("round-trips session params and drops unknown fields", () => {
    const params = {
      qoderSessionId: " sess_1 ",
      qoderAgentId: "agent_1",
      managedAgent: true,
      environmentId: "env_1",
      environmentAutoSelected: true,
      apiBaseUrl: "https://api.qoder.com",
      model: "ultimate",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      repoMountPath: "/data/workspace/paperclip",
      envFingerprint: "abc",
      repoTokenFingerprint: "def",
      authorization_token: "must-not-persist",
    };
    const normalized = sessionCodec.deserialize(params);
    expect(normalized).toEqual({
      qoderSessionId: "sess_1",
      qoderAgentId: "agent_1",
      managedAgent: true,
      environmentAutoSelected: true,
      environmentId: "env_1",
      apiBaseUrl: "https://api.qoder.com",
      model: "ultimate",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      repoMountPath: "/data/workspace/paperclip",
      envFingerprint: "abc",
      repoTokenFingerprint: "def",
    });
    expect(sessionCodec.serialize(normalized)).toEqual(normalized);
    expect(sessionCodec.getDisplayId?.(normalized)).toBe("sess_1");
  });

  it("accepts a bare legacy session id and rejects params without one", () => {
    expect(sessionCodec.deserialize({ sessionId: "sess_legacy" })).toEqual({
      qoderSessionId: "sess_legacy",
      managedAgent: false,
      environmentAutoSelected: false,
    });
    expect(sessionCodec.deserialize({ qoderAgentId: "agent_1" })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
