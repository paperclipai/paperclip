import { describe, expect, it } from "vitest";
import {
  GATEWAY_MAX_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  buildStandardPaperclipPayload,
  resolveSessionKey,
  sanitizeGatewayAgentParams,
} from "./execute.js";

describe("gateway protocol negotiation", () => {
  it("advertises a compatibility range for protocol 3 and 4 gateways", () => {
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(3);
    expect(GATEWAY_MAX_PROTOCOL_VERSION).toBe(4);
  });
});

describe("sanitizeGatewayAgentParams", () => {
  it("removes root fields rejected by strict OpenClaw agent schemas", () => {
    expect(
      sanitizeGatewayAgentParams({
        text: "template text",
        paperclip: { runId: "run-123" },
        message: "wake up",
        sessionKey: "agent:main:paperclip",
        idempotencyKey: "run-123",
        agentId: "main",
      }),
    ).toEqual({
      message: "wake up",
      sessionKey: "agent:main:paperclip",
      idempotencyKey: "run-123",
      agentId: "main",
    });
  });
});

describe("buildStandardPaperclipPayload", () => {
  it("omits workspace context by default for remote gateway wakes", () => {
    const payload = buildStandardPaperclipPayload(
      {
        runId: "run-123",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenClaw" },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: "/tmp/workspace" },
          paperclipWorkspaces: [{ cwd: "/tmp/other" }],
          paperclipRuntimeServiceIntents: [{ name: "preview" }],
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "issue-1", title: "Do the thing" },
          },
        },
      } as never,
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
      { PAPERCLIP_API_URL: "http://paperclip.local" },
      {},
    );

    expect(payload).toMatchObject({
      runId: "run-123",
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      wakeReason: "issue_assigned",
    });
    expect(payload).not.toHaveProperty("wake");
    expect(payload).not.toHaveProperty("workspace");
    expect(payload).not.toHaveProperty("workspaces");
    expect(payload).not.toHaveProperty("workspaceRuntime");
  });

  it("keeps explicit operator-supplied payloadTemplate.paperclip context", () => {
    const payload = buildStandardPaperclipPayload(
      {
        runId: "run-123",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenClaw" },
        context: {},
      } as never,
      {
        runId: "run-123",
        agentId: "agent-1",
        companyId: "company-1",
        taskId: null,
        issueId: null,
        wakeReason: null,
        wakeCommentId: null,
        approvalId: null,
        approvalStatus: null,
        issueIds: [],
      },
      {},
      {
        paperclip: {
          workspace: { cwd: "/explicit/openclaw/workspace" },
        },
      },
    );

    expect(payload).toMatchObject({
      workspace: { cwd: "/explicit/openclaw/workspace" },
      runId: "run-123",
      agentId: "agent-1",
    });
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
