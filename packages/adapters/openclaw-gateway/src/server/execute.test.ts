import { describe, expect, it } from "vitest";
import { filterOpenClawAgentParams, resolveSessionKey } from "./execute.js";

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
});

describe("filterOpenClawAgentParams", () => {
  it("strips Paperclip-only metadata and payload template keys before agent RPC", () => {
    const { params, stripped } = filterOpenClawAgentParams({
      agentId: "meridian",
      message: "wake up",
      sessionKey: "agent:meridian:paperclip",
      idempotencyKey: "run-123",
      timeout: 30_000,
      text: "legacy text",
      paperclip: { issueId: "issue-1" },
      payloadTemplate: { message: "ignored" },
      unsupported: true,
    });

    expect(params).toEqual({
      agentId: "meridian",
      message: "wake up",
      sessionKey: "agent:meridian:paperclip",
      idempotencyKey: "run-123",
      timeout: 30_000,
    });
    expect(stripped.sort()).toEqual(["paperclip", "payloadTemplate", "unsupported"]);
  });
});
