import { describe, expect, it } from "vitest";
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";
import { sessionCodec as codexSessionCodec, isCodexUnknownSessionError } from "@paperclipai/adapter-codex-local/server";
import {
  sessionCodec as cursorSessionCodec,
  isCursorUnknownSessionError,
} from "@paperclipai/adapter-cursor-local/server";
import {
  sessionCodec as geminiSessionCodec,
  isGeminiSessionUnrecoverableError,
} from "@paperclipai/adapter-gemini-local/server";
import {
  sessionCodec as opencodeSessionCodec,
  isOpenCodeUnknownSessionError,
} from "@paperclipai/adapter-opencode-local/server";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";

describe("adapter session codecs", () => {
  it.each([claudeSessionCodec.serialize, claudeSessionCodec.deserialize])("keeps only normalized Claude remote identity and valid conversation references", transform => {
    const params = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      sshClaudeConversationId: "a".repeat(64), sshClaudeAccountScope: "b".repeat(64),
      remoteExecution: { transport: "ssh", host: "fixture.example.test", port: 22, username: "agent", remoteCwd: "/work",
        useHostAuth: false, privateKey: "fixture-private-key", tailscaleSocksProxySocketPath: "/fixture/socket" },
    };
    const output = transform(params)!;
    expect(output).toMatchObject({ sessionId: params.sessionId, sshClaudeConversationId: params.sshClaudeConversationId,
      sshClaudeAccountScope: params.sshClaudeAccountScope, remoteExecution: { transport: "ssh", host: "fixture.example.test", useHostAuth: false } });
    expect(JSON.stringify(output)).not.toContain("fixture-private-key");
    expect(JSON.stringify(output)).not.toContain("/fixture/socket");
    const invalid = transform({ ...params, sshClaudeConversationId: "../../untrusted" })!;
    expect(invalid.sshClaudeConversationId).toBeUndefined();
    expect(invalid.sshClaudeAccountScope).toBeUndefined();
  });

  it("normalizes claude session params with cwd", () => {
    const parsed = claudeSessionCodec.deserialize({
      session_id: "claude-session-1",
      folder: "/tmp/workspace",
      prompt_bundle_key: "bundle-1",
    });
    expect(parsed).toEqual({
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
      promptBundleKey: "bundle-1",
    });

    const serialized = claudeSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
      promptBundleKey: "bundle-1",
    });
    expect(claudeSessionCodec.getDisplayId?.(serialized ?? null)).toBe("claude-session-1");
  });

  it("preserves Claude MCP identity across persistence so resumed turns keep their context", () => {
    const params = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/tmp/workspace",
      mcpServerIdentity: JSON.stringify([{
        name: "Paperclip projects",
        url: "http://localhost:3100/api/mcp/project-tools",
        connectionId: "paperclip-project-tools",
      }]),
    };
    expect(claudeSessionCodec.deserialize(claudeSessionCodec.serialize(params))).toEqual(params);
  });

  it("preserves claude ACP session params for ACP lane resumes", () => {
    const parsed = claudeSessionCodec.deserialize({
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-session-1",
      acpxRecordId: "record-1",
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      agent: "claude",
      cwd: "/tmp/claude-acp",
      mode: "persistent",
      stateDir: "/tmp/claude-acp-state",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });

    expect(parsed).toMatchObject({
      runtimeSessionName: "runtime-session-1",
      acpSessionId: "acp-session-1",
      agent: "claude",
      cwd: "/tmp/claude-acp",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });
    expect(claudeSessionCodec.serialize(parsed)).toEqual(parsed);
    expect(claudeSessionCodec.getDisplayId?.(parsed)).toBe("runtime-session-1");
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

  it("preserves codex ACP session params for ACP lane resumes", () => {
    const parsed = codexSessionCodec.deserialize({
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-session-1",
      acpxRecordId: "record-1",
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      agent: "codex",
      cwd: "/tmp/codex-acp",
      mode: "persistent",
      stateDir: "/tmp/codex-acp-state",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });

    expect(parsed).toMatchObject({
      runtimeSessionName: "runtime-session-1",
      acpSessionId: "acp-session-1",
      agent: "codex",
      cwd: "/tmp/codex-acp",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });
    expect(codexSessionCodec.serialize(parsed)).toEqual(parsed);
    expect(codexSessionCodec.getDisplayId?.(parsed)).toBe("runtime-session-1");
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

  it("preserves gemini ACP session params for ACP lane resumes", () => {
    const parsed = geminiSessionCodec.deserialize({
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-session-1",
      acpxRecordId: "record-1",
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      agent: "gemini",
      cwd: "/tmp/gemini-acp",
      mode: "persistent",
      stateDir: "/tmp/gemini-acp-state",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });

    expect(parsed).toMatchObject({
      runtimeSessionName: "runtime-session-1",
      acpSessionId: "acp-session-1",
      agent: "gemini",
      cwd: "/tmp/gemini-acp",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
    });
    expect(geminiSessionCodec.serialize(parsed)).toEqual(parsed);
    expect(geminiSessionCodec.getDisplayId?.(parsed)).toBe("runtime-session-1");
  });

  it("preserves acpx session params required for compatibility checks", () => {
    const parsed = acpxSessionCodec.deserialize({
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-session-1",
      acpxRecordId: "record-1",
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      agent: "claude",
      cwd: "/tmp/acpx",
      mode: "persistent",
      stateDir: "/tmp/acpx-state",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
      repoUrl: "https://example.com/repo.git",
      repoRef: "main",
      remoteExecution: {
        environmentId: "environment-1",
        leaseId: "lease-1",
      },
    });

    expect(parsed).toMatchObject({
      sessionKey: "paperclip:company:agent:task:fingerprint",
      runtimeSessionName: "runtime-session-1",
      acpxRecordId: "record-1",
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      agent: "claude",
      cwd: "/tmp/acpx",
      mode: "persistent",
      stateDir: "/tmp/acpx-state",
      configFingerprint: "fingerprint",
      workspaceId: "workspace-1",
      repoUrl: "https://example.com/repo.git",
      repoRef: "main",
      remoteExecution: {
        environmentId: "environment-1",
        leaseId: "lease-1",
      },
    });
    expect(acpxSessionCodec.serialize(parsed)).toEqual(parsed);
    expect(acpxSessionCodec.getDisplayId?.(parsed)).toBe("runtime-session-1");
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
      isGeminiSessionUnrecoverableError(
        "",
        "unknown session id abc",
      ),
    ).toBe(true);
    expect(
      isGeminiSessionUnrecoverableError(
        "",
        "checkpoint latest not found",
      ),
    ).toBe(true);
    expect(
      isGeminiSessionUnrecoverableError(
        "{\"type\":\"result\",\"subtype\":\"success\"}",
        "",
      ),
    ).toBe(false);
  });
});
