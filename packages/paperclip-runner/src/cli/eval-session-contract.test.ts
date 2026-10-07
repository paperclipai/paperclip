import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createCapabilityFixtureState } from "../mock-core/capability-control-plane-types.js";

import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";
import {
  evalSessionUsage,
  parseEvalSessionRequest,
} from "./eval-session-contract.js";
import {
  boundedEvalSessionUsage,
  runEvalSessionCli,
  evalRuntimeSystemInstructions,
  evalSessionProviderVersion,
  prepareEvalRuntimeContext,
  parseEvalSessionCliArgs,
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
  it.each(["pi", "copilot"] as const)("admits %s only with the matching CLI diagnostic opt-in", (agent) => {
    const value = request({ provider: "acpx", acpxAgent: agent, model: "explicit-provider-model" });
    expect(() => parseEvalSessionRequest(value)).toThrow("--candidate-profile");
    expect(parseEvalSessionRequest(value, { candidateProfile: agent })).toMatchObject({ acpxAgent: agent, model: "explicit-provider-model" });
    expect(() => parseEvalSessionRequest(value, { candidateProfile: agent === "pi" ? "cursor" : "pi" })).toThrow("must match");
    expect(() => parseEvalSessionRequest(request({ provider: "acpx", acpxAgent: agent, model: "" }), { candidateProfile: agent })).toThrow("request.model");
    expect(() => parseEvalSessionRequest(request({ provider: "acpx", acpxAgent: "codex", session: { acpxAgent: agent } }))).toThrow("session.acpxAgent must match");
    expect(() => parseEvalSessionRequest(request({ provider: "acpx", acpxAgent: agent, candidateProfile: agent }))).toThrow("--candidate-profile");
  });

  it("admits qualified Cursor without a diagnostic flag and preserves its explicit model", () => {
    expect(parseEvalSessionRequest(request({ provider: "acpx", acpxAgent: "cursor", model: "exact-cursor-model" })))
      .toMatchObject({ acpxAgent: "cursor", model: "exact-cursor-model" });
  });

  it("accepts only known diagnostic flags and rejects ambiguous repeated arguments", () => {
    const args = ["--request", "/tmp/request.json", "--output", "/tmp/result.json"];
    const expected = resolveQualifiedAcpxProfile("pi", "openrouter/deepseek/deepseek-v4-flash-0731");
    expect(parseEvalSessionCliArgs([...args, "--candidate-profile", "pi", "--expected-acpx-profile", JSON.stringify(expected)]))
      .toMatchObject({ candidateProfile: "pi", expectedAcpxProfile: expected });
    expect(() => parseEvalSessionCliArgs([...args, "--candidate-profile", "pi"])).toThrow("require --expected-acpx-profile");
    expect(() => parseEvalSessionCliArgs([...args, "--candidate-profile", "codex"])).toThrow("must be pi, cursor, or copilot");
    expect(() => parseEvalSessionCliArgs([...args, "--candidate-profile"])).toThrow("missing");
    expect(() => parseEvalSessionCliArgs([...args, "--request", "/tmp/other.json"])).toThrow("duplicate");
    expect(() => parseEvalSessionRequest(request(), { candidateProfile: "pi" })).toThrow("must match");
    for (const invalid of ["null", "[]", "true", "{", JSON.stringify("text")]) {
      expect(() => parseEvalSessionCliArgs([...args, "--expected-acpx-profile", invalid])).toThrow("JSON object");
    }
    expect(() => parseEvalSessionCliArgs([...args, "--expected-acpx-profile", " ".repeat(4097)])).toThrow("4096-byte bound");
  });

  it.each(["cursor"] as const)("rejects stale or incomplete %s identities before runtime construction", async (agent) => {
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-eval-profile-"));
    const model = "explicit-provider-model";
    const expected = resolveQualifiedAcpxProfile(agent, model);
    const requestPath = join(workspace, "request.json");
    const args = ["--request", requestPath, "--output", join(workspace, "output.json"), "--candidate-profile", agent];
    const serviceFactory = vi.fn(() => { throw new Error("provider must not start"); });
    try {
      await writeFile(requestPath, JSON.stringify(request({ provider: "acpx", acpxAgent: agent, model,
        runnerd: { path: join(workspace, "missing-runnerd"), sha256: "a".repeat(64) },
        session: { workingDirectory: workspace },
      })));
      const { commandDigest: _removed, ...incomplete } = expected;
      for (const stale of [
        {}, incomplete, { ...expected, unexpected: true },
        { ...expected, agentProfileVersion: expected.agentProfileVersion - 1 },
        { ...expected, commandDigest: `sha256:${"0".repeat(64)}` },
        { ...expected, reportedModelId: "another-model" },
        { ...expected, agentServerVersion: "previous-binary" },
      ]) {
        await expect(runEvalSessionCli([...args, "--expected-acpx-profile", JSON.stringify(stale)], { serviceFactory }))
          .rejects.toThrow("does not match the built runner profile");
      }
      await expect(runEvalSessionCli(args, { serviceFactory })).rejects.toThrow("require --expected-acpx-profile");
      // A matching identity reaches the independent runner-binary digest gate.
      await expect(runEvalSessionCli([...args, "--expected-acpx-profile", JSON.stringify(expected)], { serviceFactory }))
        .rejects.toThrow("ENOENT");
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(await readdir(workspace)).toEqual(["request.json"]);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

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

  it("requires explicit Pi diagnosis and accepts both qualified remote provider profiles", () => {
    expect(() => parseEvalSessionRequest(request({
      provider: "acpx",
      acpxAgent: "pi",
    }))).toThrow("--candidate-profile");
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
  it("preserves Grok's missing usage as unknown instead of manufacturing zero tokens or cost", () => {
    const parsed = { ...parseEvalSessionRequest(request()), provider: "acpx" as const, acpxAgent: "grok" as const };
    const turn = { turnId: "turn-1", status: "completed" as const, assistantText: "done", snapshot: { usageLedger: [] } as unknown as CapabilityLiveSessionSnapshot };
    expect(() => boundedEvalSessionUsage(parsed, turn)).toThrow("budget cost coverage is unavailable");
    expect(turn.status).toBe("completed");
    expect(turn.snapshot.usageLedger).toEqual([]);
    expect(() => boundedEvalSessionUsage({ ...parsed, provider: "codex", acpxAgent: undefined }, turn)).toThrow();
  });

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

  it.each(["pi", "cursor", "copilot"] as const)("keeps %s oracle results when the current turn explicitly has unavailable usage", (agent) => {
    const parsed = parseEvalSessionRequest(request({
      provider: "acpx", acpxAgent: agent, model: "exact-provider-model",
    }), { candidateProfile: agent });
    const unavailable = {
      turnId: "turn-candidate", attemptId: "attempt-1", agent,
      reason: "provider_did_not_report_usage" as const,
      tokenUsage: null, costNanodollars: null, observedAt: "2026-09-28T19:18:10.000Z",
    };
    const snapshot = {
      config: { provider: "acpx", acpxAgent: agent },
      usageLedger: [], usageUnavailable: [unavailable],
    } as unknown as CapabilityLiveSessionSnapshot;
    const turn = { turnId: unavailable.turnId, status: "completed" as const, assistantText: "Upgrade your plan to continue", snapshot };
    expect(() => boundedEvalSessionUsage(parsed, turn)).toThrow("budget cost coverage is unavailable");
    expect(turn.assistantText).toBe("Upgrade your plan to continue");
    expect(snapshot.usageLedger).toEqual([]);
    expect(() => boundedEvalSessionUsage(parsed, { ...turn, turnId: "other-turn" }))
      .toThrow("omitted usage accounting");
    expect(() => boundedEvalSessionUsage(parsed, {
      ...turn, snapshot: { ...snapshot, usageUnavailable: [{ ...unavailable, agent: agent === "pi" ? "cursor" : "pi" }] },
    })).toThrow("omitted usage accounting");
    expect(() => boundedEvalSessionUsage(parsed, {
      ...turn, snapshot: { ...snapshot, usageUnavailable: [unavailable, { ...unavailable, turnId: "second-turn" }] },
    })).toThrow("agent turn limit exceeded");
  });

  it("counts prior unavailable candidate turns alongside a later measured turn without claiming a complete total", () => {
    const parsed = parseEvalSessionRequest(request({
      provider: "acpx", acpxAgent: "cursor", model: "gpt-5.6-sol",
    }), { candidateProfile: "cursor" });
    const unavailable = {
      turnId: "prior-turn", attemptId: "attempt-1", agent: "cursor" as const,
      reason: "provider_did_not_report_usage" as const,
      tokenUsage: null, costNanodollars: null, observedAt: "2026-09-28T19:18:10.000Z",
    };
    const snapshot = {
      config: { provider: "acpx", acpxAgent: "cursor" },
      usageUnavailable: [unavailable, { ...unavailable }],
      usageLedger: [{
        receiptId: "measured-receipt", turnId: "measured-turn", providerCalls: 1,
        providerRequests: 1, inputTokens: 100, outputTokens: 10,
        cachedInputTokens: 0, reasoningTokens: 0, costNanodollars: 0,
      }],
    } as unknown as CapabilityLiveSessionSnapshot;
    const turn = { turnId: "measured-turn", status: "completed" as const, assistantText: "Done", snapshot };
    expect(() => boundedEvalSessionUsage(parsed, turn)).toThrow("agent turn limit exceeded");
    expect(() => boundedEvalSessionUsage({ ...parsed, limits: { ...parsed.limits, maxAgentTurns: 2 } }, turn)).toThrow("budget cost coverage is unavailable");
    expect(boundedEvalSessionUsage(parsed, {
      ...turn,
      snapshot: { ...snapshot, usageUnavailable: [{ ...unavailable, turnId: "measured-turn" }] },
    })).toMatchObject({ agentTurns: 1, inputTokens: 100, outputTokens: 10 });
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

  it.each(["pi", "cursor", "copilot"])("retains unpriced %s usage without inventing an invoice or substituting a model", (agent) => {
    const snapshot = {
      config: { provider: "acpx", acpxAgent: agent },
      usageLedger: [{
        receiptId: "candidate-turn-receipt", providerCalls: 1, providerRequests: 2,
        inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 400,
        reasoningTokens: 50, costNanodollars: 0,
      }],
    } as unknown as CapabilityLiveSessionSnapshot;
    expect(evalSessionUsage("exact-provider-model[context=272k]", snapshot)).toMatchObject({
      agentTurns: 1, providerRequests: 2, inputTokens: 1_000, outputTokens: 100,
      providerReportedCostNanodollars: null,
      providerReportedCostProvenance: "unavailable",
      estimatedCostNanodollars: null, pricingVersion: null, ratesUsdPerMillionTokens: null,
      costCoverage: "unpriced",
    });
    const parsed = parseEvalSessionRequest(request({ provider: "acpx", acpxAgent: agent, model: "exact-provider-model[context=272k]" }), { candidateProfile: agent as "pi" | "cursor" | "copilot" });
    expect(() => boundedEvalSessionUsage(parsed, {
      turnId: "candidate-turn", status: "completed", assistantText: "Completed provider response", snapshot,
    })).toThrow("budget cost coverage is unavailable");
    const priced = evalSessionUsage("openrouter/deepseek/deepseek-v4-flash-0731", snapshot);
    expect(priced.providerReportedCostNanodollars).toBeNull();
    expect(priced.costCoverage).toBe("estimated");
    expect(priced.estimatedCostNanodollars).toBeGreaterThan(0);
    expect(priced.pricingVersion).toBe("provider-list-prices-2026-09-07-openrouter");
    expect(priced.ratesUsdPerMillionTokens).toEqual({ input: 0.14, cachedInput: 0.028, output: 0.28 });
    expect(() => evalSessionUsage("unpriced-qualified-model", {
      ...snapshot, config: { provider: "codex" },
    } as unknown as CapabilityLiveSessionSnapshot)).toThrow("model pricing unavailable");
  });
});

describe("eval-session budget settlement", () => {
  it.each(["no_receipt", "grok_no_receipt", "unpriced", "mixed", "over_limit"] as const)("retains the completed provider outcome while failing %s accounting", async (kind) => {
    const workspace = await mkdtemp(join(tmpdir(), "eval-budget-settlement-"));
    try {
      const binary = join(workspace, "runnerd");
      await writeFile(binary, "unused fake runner");
      const agent = kind === "grok_no_receipt" ? "grok" : "copilot";
      const noReceipt = kind === "no_receipt" || kind === "grok_no_receipt";
      const model = kind === "grok_no_receipt" ? "grok-4.7" : kind === "unpriced" || kind === "no_receipt" ? "exact-unpriced-candidate" : "gpt-5.6-sol";
      const unavailable = { turnId: kind === "mixed" ? "prior-turn" : "turn-1", attemptId: "attempt-1", agent: "copilot", reason: "provider_did_not_report_usage", tokenUsage: null, costNanodollars: null, observedAt: "2026-09-28T19:00:00.000Z" };
      const state = JSON.stringify(createCapabilityFixtureState({}));
      const snapshot = {
        sessionId: "session-1", revision: 1, providerThreadId: "provider-1", providerSessionId: "provider-1",
        providerModel: { id: model, provider: agent === "grok" ? "xai" : "github" }, status: "idle", activeTurnId: null,
        createdAt: "2026-09-28T19:00:00.000Z", updatedAt: "2026-09-28T19:00:01.000Z",
        authority: { companyId: "company-1", actorId: "actor-1", taskId: "task-1", runId: "run-1", sessionId: "session-1", scenarioId: "budget-test" },
        config: { provider: "acpx", acpxAgent: agent, driver: "acpx_runtime", seedState: state, workingDirectory: workspace, scenario: { id: "budget-test" }, capabilities: [], explicitClaims: [], turnTimeoutMs: 1000 },
        mockState: state, process: null, networkEvidence: { realPaperclipRequests: 0, childPaperclipEnvironmentKeys: [] },
        transcript: [{ id: "assistant-1", role: "assistant", text: "Retained actual provider response", turnId: "turn-1", at: "2026-09-28T19:00:01.000Z" }],
        evidence: [], authorizationRecords: [], attempts: [], terminalTurns: [{ turnId: "turn-1", status: "completed" }],
        usageLedger: noReceipt ? [] : [{ receiptId: "receipt-1", turnId: "turn-1", providerCalls: 1, providerRequests: 1, inputTokens: 100, outputTokens: kind === "over_limit" ? 1_000_000 : 10, cachedInputTokens: 0, reasoningTokens: 0, costNanodollars: 0 }],
        usageUnavailable: kind === "no_receipt" || kind === "mixed" ? [unavailable] : [],
      } as unknown as CapabilityLiveSessionSnapshot;
      const sendMessage = vi.fn(async () => ({ turnId: "turn-1", status: "completed", assistantText: "Retained actual provider response", snapshot }));
      const completeAttempt = vi.fn(async () => undefined);
      const shutdown = vi.fn(async () => { snapshot.status = "closed"; });
      const input = request({ provider: "acpx", acpxAgent: agent, model,
        runnerd: { path: binary, sha256: createHash("sha256").update("unused fake runner").digest("hex") },
        session: { workingDirectory: workspace }, limits: { turnTimeoutMs: 1000, maxAgentTurns: 2, maxEstimatedCostNanodollars: 100_000_000 },
      });
      const requestPath = join(workspace, "request.json");
      const outputPath = join(workspace, "output.json");
      await writeFile(requestPath, JSON.stringify(input));
      const exitCode = await runEvalSessionCli(["--request", requestPath, "--output", outputPath, ...(agent === "grok" ? [] : ["--candidate-profile", "copilot", "--expected-acpx-profile", JSON.stringify(resolveQualifiedAcpxProfile("copilot", model))])], {
        serviceFactory: () => ({ create: async () => ({ sendMessage, completeAttempt, shutdown, snapshot: () => snapshot }) }) as never,
      });
      const artifact = JSON.parse(await readFile(outputPath, "utf8"));
      expect(exitCode).toBe(2);
      expect(artifact).not.toHaveProperty("infrastructureError");
      expect(artifact.accountingFailure).toMatchObject({ class: kind === "over_limit" ? "provider_budget_reached" : "provider_budget_coverage_unknown", retryable: false });
      expect(artifact.turn).toMatchObject({ status: "completed", assistantText: "Retained actual provider response" });
      expect(artifact.snapshot.status).toBe("closed");
      expect(artifact.acpxProfile.agent).toBe(agent);
      expect(artifact.devtools).toBeDefined();
      expect(artifact.issueThread).toBeDefined();
      if (noReceipt) expect(artifact).not.toHaveProperty("usage");
      else expect(artifact.usage.providerReportedCostNanodollars).toBeNull();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(completeAttempt).toHaveBeenCalledWith("failed", artifact.accountingFailure.class);
    } finally {
      for (const entry of await readdir(workspace)) {
        if (entry.startsWith(".paperclip-eval-runtime-context-")) await chmod(join(workspace, entry, "instructions"), 0o700).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
