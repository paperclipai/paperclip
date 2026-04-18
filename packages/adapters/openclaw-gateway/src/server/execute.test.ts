import { describe, expect, it } from "vitest";
import { resolveClaimedApiKeyPath, resolveSessionKey } from "./execute.js";

describe("resolveClaimedApiKeyPath", () => {
  it("uses an explicit claimed API key path when configured", () => {
    expect(resolveClaimedApiKeyPath("~/custom/paperclip-claimed-api-key.json", "meridian")).toBe(
      "~/custom/paperclip-claimed-api-key.json",
    );
  });

  it("derives a per-agent workspace path when agentId is configured", () => {
    expect(resolveClaimedApiKeyPath(null, "meridian")).toBe(
      "~/.openclaw/workspace-meridian/paperclip-claimed-api-key.json",
    );
  });

  it("falls back to the default workspace path for main", () => {
    expect(resolveClaimedApiKeyPath(null, "main")).toBe("~/.openclaw/workspace/paperclip-claimed-api-key.json");
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
