import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";
import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";
import {
  evalSessionUsage,
  parseEvalSessionRequest,
} from "./eval-session-contract.js";
import {
  boundedEvalSessionUsage,
  evalRuntimeSystemInstructions,
  evalSessionProviderVersion,
  prepareEvalRuntimeContext,
} from "./eval-session.js";

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
  it("materializes a production-v3 runtime context for direct live providers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-eval-context-"));
    let instructionRoot: string | null = null;
    try {
      const context = await prepareEvalRuntimeContext(workspace);
      instructionRoot = context.instructions.bundle.rootPath;
      expect(parseNativeRuntimeContext(context)).toEqual(context);
      expect(context.skills).toEqual([]);
      expect(context.mcp.assignmentSetId).toBe("paperclip-runner-direct-eval-v1");
      expect(context.instructions.entryPath).toBe("AGENTS.md");
      expect(await readFile(
        join(context.instructions.bundle.rootPath, "AGENTS.md"),
        "utf8",
      )).toContain("Paperclip direct live evaluation");
      const systemInstructions = evalRuntimeSystemInstructions(context);
      expect(systemInstructions).toContain("Paperclip direct live evaluation");
      expect(systemInstructions).toContain("Task-state changes in this mock control plane use finish_task and block_task");
      expect(systemInstructions).toContain("The current user request defines the work for this turn");
      expect(systemInstructions).toContain("Do not finish or block the mock task unless the current request asks for that state change");
      expect(systemInstructions).toContain(
        `Read-only instruction sibling root: ${context.instructions.bundle.rootPath}`,
      );
      expect((await stat(context.instructions.bundle.rootPath)).mode & 0o777)
        .toBe(0o555);
    } finally {
      if (instructionRoot !== null) {
        await chmod(instructionRoot, 0o700).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

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

  it("accepts null optional fields from the original Evalbook v1 producer", () => {
    const parsed = parseEvalSessionRequest(request({
      acpxAgent: null,
      agentCoreProfile: null,
      opencodeVersion: null,
    }));
    expect(parsed).toMatchObject({
      provider: "codex",
      driver: "codex_app_server",
    });
    expect(parsed).not.toHaveProperty("acpxAgent");
    expect(parsed).not.toHaveProperty("agentCoreProfile");
    expect(parsed).not.toHaveProperty("opencodeVersion");
  });

  it("attributes managed providers to their immutable deployed revisions", () => {
    expect(evalSessionProviderVersion(parseEvalSessionRequest(request({
      provider: "aws_agentcore",
      driver: "aws_agentcore_harness_api",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreProfile: agentCoreProfile(),
    })))).toBe("aws-agentcore-harness-context-v2");
    expect(evalSessionProviderVersion(parseEvalSessionRequest(request({
      provider: "claude_managed",
      driver: "claude_managed_agents_api",
      model: "claude-sonnet-5",
      managedProfile: {
        profileId: "managed-qualified",
        anthropicAgentId: "agent-test",
        agentVersion: "17",
        environmentId: "environment-test",
        betaVersion: "managed-agents-2026-04-01",
        maxSessionListCostUsd: 1,
      },
    })))).toBe("17");
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
  it("retains durable failed turns even when their reported usage exceeds completed-turn limits", () => {
    const parsed = parseEvalSessionRequest(request());
    const snapshot = {
      usageLedger: [{
        receiptId: "receipt-failed",
        attemptId: "attempt-1",
        providerResponseId: "response-failed",
        turnId: "turn-failed",
        observedAt: "2026-09-05T00:00:00.000Z",
        providerCalls: 2,
        providerRequests: 2,
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costNanodollars: 200_000_000,
      }],
    } as unknown as CapabilityLiveSessionSnapshot;
    const failedTurn = {
      turnId: "turn-failed",
      status: "failed" as const,
      assistantText: "",
      snapshot,
    };

    expect(boundedEvalSessionUsage(parsed, failedTurn)).toMatchObject({
      agentTurns: 2,
      providerReportedCostNanodollars: 200_000_000,
    });
    expect(() => boundedEvalSessionUsage(parsed, {
      ...failedTurn,
      status: "completed",
    })).toThrow("agent turn limit exceeded");
  });

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
