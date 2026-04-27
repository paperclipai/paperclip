import { describe, expect, it } from "vitest";
import { buildWakeText, resolveSessionKey } from "./execute.js";

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

describe("buildWakeText", () => {
  it("steers agents away from pipe-to-interpreter shell patterns", () => {
    const wakeText = buildWakeText(
      {
        runId: "run-123",
        agentId: "agent-123",
        companyId: "company-123",
        taskId: null,
        issueId: "issue-456",
        wakeReason: null,
        wakeCommentId: null,
        approvalId: null,
        approvalStatus: null,
        issueIds: [],
      },
      {
        PAPERCLIP_RUN_ID: "run-123",
        PAPERCLIP_AGENT_ID: "agent-123",
        PAPERCLIP_COMPANY_ID: "company-123",
        PAPERCLIP_API_URL: "http://127.0.0.1:3100/api",
      },
      "",
    );

    expect(wakeText).toContain("Prefer the Paperclip MCP/API client");
    expect(wakeText).toContain("CRITICAL SECURITY RULE");
    expect(wakeText).toContain("NEVER pipe curl/wget output into an interpreter");
    expect(wakeText).not.toContain("GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID");
  });
});
