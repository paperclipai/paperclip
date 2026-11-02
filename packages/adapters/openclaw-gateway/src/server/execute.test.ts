import { describe, expect, it } from "vitest";
import { buildAgentParams, resolveClaimedApiKeyPath, resolveSessionKey } from "./execute.js";

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

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});
