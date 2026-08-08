/**
 * Tests that the startup probe in testEnvironment never produces adapter_failed
 * when a fallback (disk cache or configured model) is available.
 *
 * Strategy: mock discoverOpenCodeModelsResilient AND ensureOpenCodeModelConfiguredAndAvailable
 * to simulate a degraded probe, verify testEnvironment emits a warn check (not an error).
 *
 * Note: vi.mock replaces module exports but not internal references between functions in the
 * same module. We mock both the discovery function and the model-availability check to avoid
 * the real 20-second probe timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockDiscoverResilient, mockEnsureModelAvailable } = vi.hoisted(() => ({
  mockDiscoverResilient: vi.fn(),
  mockEnsureModelAvailable: vi.fn(),
}));

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    discoverOpenCodeModelsResilient: mockDiscoverResilient,
    ensureOpenCodeModelConfiguredAndAvailable: mockEnsureModelAvailable,
  };
});

// Mock execution-target to avoid real subprocess calls.
const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  resolveAdapterExecutionTargetCwd,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "step_start", sessionID: "s1" }),
      JSON.stringify({ type: "text", sessionID: "s1", part: { text: "hello" } }),
      JSON.stringify({ type: "step_finish", sessionID: "s1", part: { cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }),
    ].join("\n"),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  resolveAdapterExecutionTargetCwd: vi.fn((_target: unknown, configuredCwd: unknown, fallbackCwd: string) => {
    if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
    return fallbackCwd;
  }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

describe("testEnvironment — startup probe resilience", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("warm disk cache + hung probe → warn check, no adapter_failed status", async () => {
    const cachedModels = [{ id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" }];
    mockDiscoverResilient.mockResolvedValue({
      models: cachedModels,
      source: "disk_cache",
      cacheAge: 5000,
    });
    mockEnsureModelAvailable.mockResolvedValue(cachedModels);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "opencode_local",
      config: { command: "opencode", model: "anthropic/claude-sonnet-4-5" },
      executionTarget: null,
    });

    const errorChecks = result.checks.filter((c) => c.level === "error");
    expect(errorChecks).toHaveLength(0);

    const degradedCheck = result.checks.find((c) => c.code === "opencode_models_discovery_degraded");
    expect(degradedCheck).toBeDefined();
    expect(degradedCheck?.level).toBe("warn");

    // Status must not be "fail" due to discovery degradation alone.
    expect(result.status).not.toBe("fail");
  });

  it("configured model fallback + hung probe → warn check, no adapter_failed status", async () => {
    const fallbackModels = [{ id: "openai/gpt-4o", label: "openai/gpt-4o" }];
    mockDiscoverResilient.mockResolvedValue({
      models: fallbackModels,
      source: "configured_model",
    });
    mockEnsureModelAvailable.mockResolvedValue(fallbackModels);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "opencode_local",
      config: { command: "opencode", model: "openai/gpt-4o" },
      executionTarget: null,
    });

    const errorChecks = result.checks.filter((c) => c.level === "error");
    expect(errorChecks).toHaveLength(0);

    const degradedCheck = result.checks.find((c) => c.code === "opencode_models_discovery_degraded");
    expect(degradedCheck).toBeDefined();
    expect(degradedCheck?.level).toBe("warn");

    expect(result.status).not.toBe("fail");
  });
});
