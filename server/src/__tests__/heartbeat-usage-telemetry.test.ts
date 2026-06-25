import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildRunUsageJson } from "../services/heartbeat.js";

// Representative claude_local run-shape telemetry (PB-81 engineer-run shape).
// buildRunUsageJson spreads this verbatim; derivation is covered in parse.test.ts.
const TELEMETRY = {
  turnCount: 147,
  toolCallCount: 60,
  toolLessTurnCount: 87,
  toolLessTurnRatio: 0.5918367346938775,
  residentWindowTokens: 162579,
  usageFormulaVersion: "claude_local.telemetry.v1",
};

const USAGE_TOTALS = { inputTokens: 7724, cachedInputTokens: 7655530, outputTokens: 74235 };

function adapterResult(overrides: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "anthropic",
    biller: "anthropic",
    model: "claude-opus-4-8",
    billingType: "subscription",
    costUsd: 1.23,
    usage: { ...USAGE_TOTALS },
    usageTelemetry: { ...TELEMETRY },
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof buildRunUsageJson>[0]> = {}) {
  return {
    normalizedUsage: { ...USAGE_TOTALS },
    rawUsage: { ...USAGE_TOTALS },
    adapterResult: adapterResult(),
    derivedFromSessionTotals: false,
    persistedSessionId: "sess-1",
    runId: "run-1",
    agentId: "agent-1",
    adapterType: "claude_local",
    issueId: "PB-81",
    sessionReused: false,
    taskSessionReused: false,
    freshSession: true,
    sessionRotated: false,
    sessionRotationReason: null,
    ...overrides,
  };
}

describe("buildRunUsageJson", () => {
  it("persists adapter run-shape telemetry flat into usageJson", () => {
    const usage = buildRunUsageJson(input());

    expect(usage).toMatchObject({
      turnCount: 147,
      toolCallCount: 60,
      toolLessTurnCount: 87,
      toolLessTurnRatio: 0.5918367346938775,
      residentWindowTokens: 162579,
      usageFormulaVersion: "claude_local.telemetry.v1",
    });
  });

  it("persists authoritative run mapping", () => {
    const usage = buildRunUsageJson(input());

    expect(usage).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      issueId: "PB-81",
    });
  });

  it("preserves existing usage totals and raw totals unchanged", () => {
    const usage = buildRunUsageJson(input());

    expect(usage).toMatchObject({
      inputTokens: 7724,
      cachedInputTokens: 7655530,
      outputTokens: 74235,
      rawInputTokens: 7724,
      rawCachedInputTokens: 7655530,
      rawOutputTokens: 74235,
    });
  });

  it("does not let adapter telemetry override reserved usageJson fields", () => {
    const usage = buildRunUsageJson(
      input({
        adapterResult: adapterResult({
          usageTelemetry: {
            ...TELEMETRY,
            inputTokens: 999,
            rawInputTokens: 999,
            runId: "telemetry-run",
            agentId: "telemetry-agent",
            provider: "telemetry-provider",
          },
        }),
      }),
    );

    expect(usage).toMatchObject({
      inputTokens: 7724,
      rawInputTokens: 7724,
      runId: "run-1",
      agentId: "agent-1",
      provider: "anthropic",
      turnCount: 147,
    });
  });

  it("persists a telemetry-only timed-out result-less run when it did work (turnCount > 0)", () => {
    const usage = buildRunUsageJson(
      input({
        normalizedUsage: null,
        rawUsage: null,
        adapterResult: adapterResult({
          timedOut: true,
          costUsd: null,
          usage: undefined,
          usageTelemetry: { ...TELEMETRY, turnCount: 42 },
        }),
      }),
    );

    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({
      turnCount: 42,
      residentWindowTokens: 162579,
      runId: "run-1",
      agentId: "agent-1",
      adapterType: "claude_local",
    });
    expect(usage).not.toHaveProperty("inputTokens");
    expect(usage).not.toHaveProperty("rawInputTokens");
    expect(usage).not.toHaveProperty("costUsd");
  });

  it("returns null for a tokenless, costless, turnless failure", () => {
    const usage = buildRunUsageJson(
      input({
        normalizedUsage: null,
        rawUsage: null,
        adapterResult: adapterResult({
          exitCode: 1,
          costUsd: null,
          usage: undefined,
          usageTelemetry: { ...TELEMETRY, turnCount: 0 },
        }),
      }),
    );

    expect(usage).toBeNull();
  });

  it("still persists a turnless run when token usage or cost is present", () => {
    const withUsage = buildRunUsageJson(
      input({
        adapterResult: adapterResult({ usageTelemetry: { ...TELEMETRY, turnCount: 0 } }),
      }),
    );
    expect(withUsage).not.toBeNull();

    const costOnly = buildRunUsageJson(
      input({
        normalizedUsage: null,
        rawUsage: null,
        adapterResult: adapterResult({
          usage: undefined,
          costUsd: 0.5,
          usageTelemetry: { ...TELEMETRY, turnCount: 0 },
        }),
      }),
    );
    expect(costOnly).not.toBeNull();
  });

  it("omits telemetry keys for an adapter that emits none, keeping mapping and totals", () => {
    const usage = buildRunUsageJson(
      input({
        adapterType: "codex_local",
        adapterResult: adapterResult({ provider: "openai", biller: "openai", usageTelemetry: null }),
      }),
    );

    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({ adapterType: "codex_local", runId: "run-1", inputTokens: 7724 });
    expect(usage).not.toHaveProperty("turnCount");
    expect(usage).not.toHaveProperty("usageFormulaVersion");
  });
});
