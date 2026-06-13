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
});

describe("resolveClaimedApiKeyPath", () => {
  it("returns the default path when value is undefined", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });

  it("returns the default path when value is null", () => {
    expect(resolveClaimedApiKeyPath(null)).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });

  it("returns the default path when value is empty string", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });

  it("returns the configured path when a non-empty string is provided", () => {
    expect(
      resolveClaimedApiKeyPath(
        "/home/user/.openclaw/workspace-researcher/paperclip-claimed-api-key.json",
      ),
    ).toBe("/home/user/.openclaw/workspace-researcher/paperclip-claimed-api-key.json");
  });

  it("trims whitespace from the configured path", () => {
    expect(resolveClaimedApiKeyPath("  /tmp/key.json  ")).toBe("/tmp/key.json");
  });

  it("returns the default path for non-string input", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
    expect(resolveClaimedApiKeyPath({})).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
    expect(resolveClaimedApiKeyPath([])).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });
});
