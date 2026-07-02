import { describe, expect, it } from "vitest";
import { buildAgentParams, estimateBoundaryTokens, resolveSessionKey, resolveSyntheticPromptBoundary } from "./execute.js";

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

describe("synthetic prompt boundary", () => {
  it("estimates prompt tokens deterministically", () => {
    expect(estimateBoundaryTokens("")).toBe(0);
    expect(estimateBoundaryTokens("abcd")).toBe(1);
    expect(estimateBoundaryTokens("abcde")).toBe(2);
  });

  it("blocks prompts above the configured synthetic cap", () => {
    expect(
      resolveSyntheticPromptBoundary({
        config: { maxEstimatedPromptTokens: 1 },
        message: "this message is intentionally over one estimated token",
        payload: { message: "small" },
      }),
    ).toMatchObject({ exceeded: true, limit: 1 });
  });

  it("allows prompts within the configured synthetic cap", () => {
    expect(
      resolveSyntheticPromptBoundary({
        config: { maxEstimatedPromptTokens: 10_000 },
        message: "short",
        payload: { message: "short" },
      }),
    ).toMatchObject({ exceeded: false, limit: 10_000 });
  });

  it("honors prompt cap aliases in precedence order", () => {
    expect(
      resolveSyntheticPromptBoundary({
        config: { maxPromptTokens: 2 },
        message: "this message exceeds the maxPromptTokens alias",
        payload: { message: "small" },
      }),
    ).toMatchObject({ exceeded: true, limit: 2 });

    expect(
      resolveSyntheticPromptBoundary({
        config: { promptTokenLimit: 2 },
        message: "this message exceeds the promptTokenLimit alias",
        payload: { message: "small" },
      }),
    ).toMatchObject({ exceeded: true, limit: 2 });

    expect(
      resolveSyntheticPromptBoundary({
        config: { maxEstimatedPromptTokens: 10_000, maxPromptTokens: 2, promptTokenLimit: 2 },
        message: "short",
        payload: { message: "short" },
      }),
    ).toMatchObject({ exceeded: false, limit: 10_000 });
  });

  it("enforces a default cap unless explicitly disabled", () => {
    expect(
      resolveSyntheticPromptBoundary({
        config: {},
        message: "short",
        payload: { message: "short" },
      }),
    ).toMatchObject({ exceeded: false, limit: 100_000 });

    expect(
      resolveSyntheticPromptBoundary({
        config: { maxEstimatedPromptTokens: 0 },
        message: "short",
        payload: { message: "short" },
      }),
    ).toMatchObject({ exceeded: false, limit: null });
  });
});
