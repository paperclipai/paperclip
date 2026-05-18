import { describe, expect, it } from "vitest";
import { resolveClaimedApiKeyPath, resolveSessionKey } from "./execute.js";

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

  it("does not prefix the shared main gateway agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "main",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("paperclip");
  });
});

describe("resolveClaimedApiKeyPath", () => {
  it("uses an explicit claimed API key path when configured", () => {
    expect(
      resolveClaimedApiKeyPath({
        agentId: "kimi",
        claimedApiKeyPath: "/tmp/kimi/key.json",
      }),
    ).toBe("/tmp/kimi/key.json");
  });

  it("defaults non-main gateway agents to isolated workspace key paths", () => {
    expect(resolveClaimedApiKeyPath({ agentId: "Kimi" })).toBe(
      "~/.openclaw/workspace-kimi/paperclip-claimed-api-key.json",
    );
  });

  it("keeps the shared workspace path for the main gateway agent", () => {
    expect(resolveClaimedApiKeyPath({ agentId: "main" })).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });
});
