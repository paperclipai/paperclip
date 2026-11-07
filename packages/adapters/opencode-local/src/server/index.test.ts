import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("opencode_local sessionCodec", () => {
  it("round-trips the remote execution identity with the saved session", () => {
    const params = {
      sessionId: "session-remote",
      cwd: "/remote/workspace/.paperclip-runtime/tasks/company-1/agent-1/task-1/workspace",
      workspaceId: "workspace-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      remoteExecution: {
        transport: "ssh",
        host: "10.0.0.5",
        port: 2222,
        username: "agent",
        remoteCwd: "/remote/workspace/.paperclip-runtime/tasks/company-1/agent-1/task-1/workspace",
      },
    };
    const saved = sessionCodec.serialize(params);
    expect(saved).toEqual(params);
    expect(sessionCodec.deserialize(saved)).toEqual(params);
  });

  it("keeps local sessions without a remote identity unchanged", () => {
    const saved = sessionCodec.serialize({ sessionId: "session-local", cwd: "/workdir" });
    expect(saved).toEqual({ sessionId: "session-local", cwd: "/workdir" });
    expect(sessionCodec.deserialize(saved)).toEqual({ sessionId: "session-local", cwd: "/workdir" });
  });

  it("drops malformed remote execution values instead of failing the session", () => {
    const saved = sessionCodec.serialize({
      sessionId: "session-bad",
      remoteExecution: "not-a-record",
    });
    expect(saved).toEqual({ sessionId: "session-bad" });
  });
});
