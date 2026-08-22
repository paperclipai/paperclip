import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("claude_local sessionCodec", () => {
  it("round-trips CLI resume discriminators", () => {
    const params = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      promptBundleKey: "prompt-v1",
      mcpServerIdentity: '[{"name":"paperclip"}]',
      claudeConfigDir: "/profiles/account-b/.claude",
      remoteExecution: { kind: "ssh", host: "runner.example" },
      workspaceId: "workspace-1",
      repoUrl: "https://example.com/repo.git",
      repoRef: "main",
    };

    expect(sessionCodec.deserialize(params)).toEqual(params);
    expect(sessionCodec.serialize(params)).toEqual(params);
  });

  it("normalizes legacy snake-case profile fields", () => {
    expect(sessionCodec.deserialize({
      session_id: "22222222-2222-4222-8222-222222222222",
      claude_config_dir: "/profiles/account-a/.claude",
      mcp_server_identity: "[]",
      remote_execution: { kind: "ssh" },
    })).toEqual({
      sessionId: "22222222-2222-4222-8222-222222222222",
      claudeConfigDir: "/profiles/account-a/.claude",
      mcpServerIdentity: "[]",
      remoteExecution: { kind: "ssh" },
    });
  });
});
