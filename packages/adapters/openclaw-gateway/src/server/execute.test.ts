import { describe, expect, it } from "vitest";
import { buildPaperclipEnvForWake, buildWakeText, execute, resolveSessionKey } from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("uses the configured claimed api key path in the wake text and env", async () => {
    const ctx = {
      config: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        claimedApiKeyPath: "/tmp/custom-paperclip-key.json",
      },
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Meridian",
      },
      context: {},
      onMeta: async () => undefined,
      onLog: async () => undefined,
    } as any;
    const wakePayload = {
      runId: "run-123",
      agentId: "agent-123",
      companyId: "company-123",
      taskId: null,
      issueId: null,
      wakeReason: null,
      wakeCommentId: null,
      approvalId: null,
      approvalStatus: null,
      issueIds: [],
    };

    const env = buildPaperclipEnvForWake(ctx, wakePayload);
    const wakeText = buildWakeText(wakePayload, env, "");

    expect(env.PAPERCLIP_CLAIMED_API_KEY_PATH).toBe("/tmp/custom-paperclip-key.json");
    expect(wakeText).toContain("PAPERCLIP_CLAIMED_API_KEY_PATH=/tmp/custom-paperclip-key.json");
    expect(wakeText).toContain("Load PAPERCLIP_API_KEY from /tmp/custom-paperclip-key.json");
  });

  it("does not inject PAPERCLIP_CLAIMED_API_KEY_PATH when it is not configured", async () => {
    const ctx = {
      config: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
      },
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Meridian",
      },
      context: {},
      onMeta: async () => undefined,
      onLog: async () => undefined,
    } as any;
    const wakePayload = {
      runId: "run-123",
      agentId: "agent-123",
      companyId: "company-123",
      taskId: null,
      issueId: null,
      wakeReason: null,
      wakeCommentId: null,
      approvalId: null,
      approvalStatus: null,
      issueIds: [],
    };

    const env = buildPaperclipEnvForWake(ctx, wakePayload);
    const wakeText = buildWakeText(wakePayload, env, "");

    expect(env.PAPERCLIP_CLAIMED_API_KEY_PATH).toBeUndefined();
    expect(wakeText).not.toContain("PAPERCLIP_CLAIMED_API_KEY_PATH=");
    expect(wakeText).toContain("Load PAPERCLIP_API_KEY from ~/.openclaw/workspace/paperclip-claimed-api-key.json");
  });
});
