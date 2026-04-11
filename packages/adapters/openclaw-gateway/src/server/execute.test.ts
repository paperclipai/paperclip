import { describe, expect, it } from "vitest";
import { execute, resolveSessionKey } from "./execute.js";

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

  it("uses the configured claimed api key path in the wake payload", async () => {
    let stdout = "";
    const result = await execute({
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
      onLog: async (stream: string, chunk: string) => {
        if (stream === "stdout") stdout += chunk;
      },
    } as any);

    expect(result.errorCode).toBe("openclaw_gateway_connection_failed");
    expect(result.errorMessage).toContain("ws://127.0.0.1:18789");
    expect(stdout).toContain("PAPERCLIP_CLAIMED_API_KEY_PATH=/tmp/custom-paperclip-key.json");
    expect(stdout).toContain("Load PAPERCLIP_API_KEY from /tmp/custom-paperclip-key.json");
  });
});
