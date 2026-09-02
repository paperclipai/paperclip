import { describe, expect, it } from "vitest";

import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";
import {
  evalSessionUsage,
  parseEvalSessionRequest,
} from "./eval-session-contract.js";

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: "paperclip-runner/eval-session-request/v1",
    attemptId: "attempt-1",
    prompt: "Inspect the governed task.",
    model: "gpt-5.6-sol",
    provider: "codex",
    runnerd: { path: "/tmp/paperclip-runnerd", sha256: "a".repeat(64) },
    limits: {
      turnTimeoutMs: 120_000,
      maxAgentTurns: 1,
      maxEstimatedCostNanodollars: 100_000_000,
    },
    session: {},
    ...overrides,
  };
}

function agentCoreProfile(overrides: Record<string, unknown> = {}) {
  return {
    profileId: "agentcore-qualified",
    region: "us-east-1",
    accountId: "123456789012",
    harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test",
    harnessVersion: "1",
    endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness-endpoint/test",
    endpointQualifier: "paperclip",
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
    memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test",
    memoryId: "memory-test",
    invocationRoleArn: "arn:aws:iam::123456789012:role/paperclip-agentcore",
    contextBucket: "paperclip-agentcore-context",
    contextPrefix: "paperclip/agentcore/test",
    contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
    qualificationRevision: "aws-agentcore-harness-context-v2",
    eventExpiryDays: 90,
    maxEstimatedSessionCostUsd: 1,
    maxIterations: 8,
    maxOutputTokens: 4_096,
    timeoutSeconds: 300,
    ...overrides,
  };
}

describe("eval-session request contract", () => {
  it("normalizes the current local live-session provider contract", () => {
    expect(parseEvalSessionRequest(request())).toMatchObject({
      provider: "codex",
      driver: "codex_app_server",
      model: "gpt-5.6-sol",
    });
    expect(parseEvalSessionRequest(request({
      provider: "acpx",
      driver: "acpx_runtime",
      acpxAgent: "claude",
      model: "claude-sonnet-5",
    }))).toMatchObject({ provider: "acpx", acpxAgent: "claude" });
  });

  it("rejects Pi and accepts both qualified remote provider profiles", () => {
    expect(() => parseEvalSessionRequest(request({
      provider: "acpx",
      acpxAgent: "pi",
    }))).toThrow("Pi ACPX profile is not available");
    expect(parseEvalSessionRequest(request({
      provider: "aws_agentcore",
      driver: "aws_agentcore_harness_api",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreProfile: agentCoreProfile(),
    }))).toMatchObject({
      provider: "aws_agentcore",
      agentCoreProfile: {
        contextBucket: "paperclip-agentcore-context",
        contextPrefix: "paperclip/agentcore/test",
        contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
      },
    });
    expect(parseEvalSessionRequest(request({
      provider: "claude_managed",
      driver: "claude_managed_agents_api",
      model: "claude-sonnet-5",
      managedProfile: {
        profileId: "managed-qualified",
        anthropicAgentId: "agent-test",
        agentVersion: "1",
        environmentId: "environment-test",
        betaVersion: "managed-agents-2026-04-01",
        maxSessionListCostUsd: 1,
      },
    }))).toMatchObject({ provider: "claude_managed" });
  });

  it("requires complete remote profiles and AgentCore S3/KMS qualification", () => {
    expect(() => parseEvalSessionRequest(request({
      provider: "aws_agentcore",
      model: "global.anthropic.claude-sonnet-4-6",
    }))).toThrow("request.agentCoreProfile must be an object");
    expect(() => parseEvalSessionRequest(request({
      provider: "aws_agentcore",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreProfile: agentCoreProfile({ contextKmsKeyArn: "" }),
    }))).toThrow("contextKmsKeyArn");
  });

  it.each(["latest", "0", "01", "2147483648"])(
    "rejects noncanonical Managed agentVersion %s",
    (agentVersion) => {
      expect(() => parseEvalSessionRequest(request({
        provider: "claude_managed",
        model: "claude-sonnet-5",
        managedProfile: {
          profileId: "managed-qualified",
          anthropicAgentId: "agent-test",
          agentVersion,
          environmentId: "environment-test",
          betaVersion: "managed-agents-2026-04-01",
          maxSessionListCostUsd: 1,
        },
      }))).toThrow("canonical positive int32 string");
    },
  );

  it("rejects contradictory session and execution inputs", () => {
    expect(() => parseEvalSessionRequest(request({
      provider: "opencode",
      driver: "codex_app_server",
    }))).toThrow("provider/driver mismatch");
    expect(() => parseEvalSessionRequest(request({
      session: { requestedModel: "different-model" },
    }))).toThrow("requestedModel must match");
    expect(() => parseEvalSessionRequest(request({
      includeCollaborationModeInstructions: false,
    }))).toThrow("requires collaboration-mode instructions");
  });
});

describe("eval-session usage", () => {
  it("deduplicates receipts and applies the versioned model price", () => {
    const receipt = {
      receiptId: "receipt-1",
      attemptId: "attempt-1",
      providerResponseId: "response-1",
      turnId: "turn-1",
      observedAt: "2026-09-01T00:00:00.000Z",
      providerCalls: 1,
      providerRequests: 2,
      inputTokens: 1_000,
      outputTokens: 100,
      cachedInputTokens: 400,
      reasoningTokens: 50,
      costNanodollars: 6_000_000,
    };
    const snapshot = {
      usageLedger: [receipt, { ...receipt }],
    } as unknown as CapabilityLiveSessionSnapshot;
    expect(evalSessionUsage("gpt-5.6-sol", snapshot)).toMatchObject({
      agentTurns: 1,
      providerRequests: 2,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
      reasoningTokens: 50,
      providerReportedCostNanodollars: 6_000_000,
      estimatedCostNanodollars: 6_200_000,
    });
  });

  it("fails closed when a completed turn has no usage receipt", () => {
    expect(() => evalSessionUsage(
      "gpt-5.6-sol",
      { usageLedger: [] } as unknown as CapabilityLiveSessionSnapshot,
    )).toThrow("omitted usage accounting");
  });
});
