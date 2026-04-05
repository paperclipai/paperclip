import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./execute.js";

describe("resolveSessionKey", () => {
  const issueId = "issue-123";
  const runId = "run-456";

  it("returns agent-scoped issue key when agentId is 'eng'", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      configuredSessionKey: null,
      runId,
      issueId,
      agentId: "eng",
    });
    expect(key).toBe("agent:eng:paperclip:issue:issue-123");
  });

  it("returns agent-scoped issue key when agentId is 'coo'", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      configuredSessionKey: null,
      runId,
      issueId,
      agentId: "coo",
    });
    expect(key).toBe("agent:coo:paperclip:issue:issue-123");
  });

  it("returns legacy issue key when agentId is null", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      configuredSessionKey: null,
      runId,
      issueId,
      agentId: null,
    });
    expect(key).toBe("paperclip:issue:issue-123");
  });

  it("returns legacy issue key when agentId is 'main'", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      configuredSessionKey: null,
      runId,
      issueId,
      agentId: "main",
    });
    expect(key).toBe("paperclip:issue:issue-123");
  });

  it("returns agent-scoped run key when agentId is set", () => {
    const key = resolveSessionKey({
      strategy: "run",
      configuredSessionKey: null,
      runId,
      issueId: null,
      agentId: "eng",
    });
    expect(key).toBe("agent:eng:paperclip:run:run-456");
  });

  it("returns legacy run key when agentId is null", () => {
    const key = resolveSessionKey({
      strategy: "run",
      configuredSessionKey: null,
      runId,
      issueId: null,
      agentId: null,
    });
    expect(key).toBe("paperclip:run:run-456");
  });

  it("returns legacy run key when agentId is 'main'", () => {
    const key = resolveSessionKey({
      strategy: "run",
      configuredSessionKey: null,
      runId,
      issueId: null,
      agentId: "main",
    });
    expect(key).toBe("paperclip:run:run-456");
  });

  it("returns agent-scoped fallback when strategy is fixed with unscoped key", () => {
    const key = resolveSessionKey({
      strategy: "fixed",
      configuredSessionKey: "my-session",
      runId,
      issueId: null,
      agentId: "coo",
    });
    expect(key).toBe("agent:coo:my-session");
  });

  it("preserves existing agent-scoped fixed keys without double-prefixing", () => {
    const key = resolveSessionKey({
      strategy: "fixed",
      configuredSessionKey: "agent:coo:paperclip",
      runId,
      issueId: null,
      agentId: "coo",
    });
    expect(key).toBe("agent:coo:paperclip");
  });

  it("returns default fallback without agentId", () => {
    const key = resolveSessionKey({
      strategy: "fixed",
      configuredSessionKey: null,
      runId,
      issueId: null,
      agentId: null,
    });
    expect(key).toBe("paperclip");
  });

  it("falls back to issue strategy default when issueId is null", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      configuredSessionKey: null,
      runId,
      issueId: null,
      agentId: "eng",
    });
    expect(key).toBe("agent:eng:paperclip");
  });
});
