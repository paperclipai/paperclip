import { describe, expect, it } from "vitest";
import { isSensitiveLogKey, resolveSessionKey } from "./execute.js";

describe("isSensitiveLogKey", () => {
  it("matches existing snake/dash-bounded sensitive keys", () => {
    expect(isSensitiveLogKey("authorization")).toBe(true);
    expect(isSensitiveLogKey("api_key")).toBe(true);
    expect(isSensitiveLogKey("x-openclaw-auth")).toBe(true);
    expect(isSensitiveLogKey("x-openclaw-token")).toBe(true);
  });

  it("matches camelCase gatewayToken and gatewayPassword", () => {
    expect(isSensitiveLogKey("gatewayToken")).toBe(true);
    expect(isSensitiveLogKey("gatewayPassword")).toBe(true);
  });

  it("does not match benign keys", () => {
    expect(isSensitiveLogKey("agentId")).toBe(false);
    expect(isSensitiveLogKey("issueId")).toBe(false);
    expect(isSensitiveLogKey("model")).toBe(false);
    expect(isSensitiveLogKey("gatewayUrl")).toBe(false);
  });
});

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
