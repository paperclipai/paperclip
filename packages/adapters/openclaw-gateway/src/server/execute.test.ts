import { describe, expect, it } from "vitest";
import { buildOpenClawGatewayAgentParams, resolveSessionKey } from "./execute.js";

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

describe("buildOpenClawGatewayAgentParams", () => {
  it("does not send Paperclip metadata as a top-level gateway agent param", () => {
    const params = buildOpenClawGatewayAgentParams({
      payloadTemplate: {
        text: "template text",
        model: "gpt",
        paperclip: { issueId: "issue-123" },
      },
      message: "wake text with structured Paperclip context",
      sessionKey: "agent:joe:paperclip:issue:issue-123",
      runId: "run-123",
      waitTimeoutMs: 30_000,
      configuredAgentId: "joe",
    });

    expect(params).toMatchObject({
      message: "wake text with structured Paperclip context",
      sessionKey: "agent:joe:paperclip:issue:issue-123",
      idempotencyKey: "run-123",
      agentId: "joe",
      timeout: 30_000,
      model: "gpt",
    });
    expect(params).not.toHaveProperty("text");
    expect(params).not.toHaveProperty("paperclip");
  });
});
