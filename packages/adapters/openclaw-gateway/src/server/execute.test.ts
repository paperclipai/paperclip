import { describe, expect, it } from "vitest";
import {
  buildScopedClaimedApiKeyPath,
  buildWakeText,
  resolveClaimedApiKeyPath,
  resolveSessionKey,
} from "./execute.js";

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

describe("claimed API key path", () => {
  it("defaults to a company and agent scoped path", () => {
    expect(resolveClaimedApiKeyPath(undefined, "company-1", "agent-1")).toBe(
      "~/.openclaw/workspace/paperclip/company-1/agent-1/claimed-api-key.json",
    );
  });

  it("falls back to the legacy flat path when ids are missing", () => {
    expect(buildScopedClaimedApiKeyPath(null, "agent-1")).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });
});

describe("buildWakeText", () => {
  it("includes scoped path guidance and claimed-key preflight", () => {
    const text = buildWakeText(
      {
        runId: "run-123",
        agentId: "agent-1",
        companyId: "company-1",
        taskId: "issue-1",
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        wakeCommentId: null,
        approvalId: null,
        approvalStatus: null,
        issueIds: [],
      },
      {
        PAPERCLIP_RUN_ID: "run-123",
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_COMPANY_ID: "company-1",
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
        PAPERCLIP_CLAIMED_API_KEY_PATH:
          "~/.openclaw/workspace/paperclip/company-1/agent-1/claimed-api-key.json",
      },
      "",
    );

    expect(text).toContain("PAPERCLIP_CLAIMED_API_KEY_PATH=");
    expect(text).toContain("Legacy flat path for migration only");
    expect(text).toContain("Claimed-key preflight before any API call");
    expect(text).toContain("Verify file.companyId == company-1");
  });
});
