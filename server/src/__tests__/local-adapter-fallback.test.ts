import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "../adapters/index.js";

const claudeExecuteMock = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "claude fallback completed",
})));

const localExecuteMock = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "local completed",
})));

const localHealthMock = vi.hoisted(() => vi.fn(async () => ({
  available: true,
  url: "http://localhost:1234/v1",
  models: ["qwen/qwen3-coder-30b"],
})));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  execute: claudeExecuteMock,
  listClaudeSkills: async () => ({ entries: [] }),
  syncClaudeSkills: async () => ({ entries: [] }),
  listClaudeModels: async () => [],
  refreshClaudeModels: async () => [],
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  sessionCodec: null,
  getQuotaWindows: async () => ({ provider: "anthropic", ok: true, windows: [] }),
}));

vi.mock("@paperclipai/adapter-local/server", () => ({
  execute: localExecuteMock,
  getLocalInferenceHealth: localHealthMock,
  listLocalModels: async () => [],
  testEnvironment: async () => ({
    adapterType: "local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
}));

import { requireServerAdapter } from "../adapters/index.js";

function makeContext(): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Ada",
      adapterType: "local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "qwen/qwen3-coder-30b",
      baseUrl: "http://localhost:1234/v1",
      instructionsFilePath: "/tmp/AGENTS.md",
      maxTurns: 3,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("local adapter fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the local adapter when the inference probe is available", async () => {
    localHealthMock.mockResolvedValue({
      available: true,
      url: "http://localhost:1234/v1",
      models: ["qwen/qwen3-coder-30b"],
    });

    const result = await requireServerAdapter("local").execute(makeContext());

    expect(result.summary).toBe("local completed");
    expect(localExecuteMock).toHaveBeenCalledTimes(1);
    expect(claudeExecuteMock).not.toHaveBeenCalled();
  });

  it("falls back to claude_local with instructions and max turns", async () => {
    localHealthMock.mockResolvedValue({
      available: false,
      url: "http://localhost:1234/v1",
      models: [],
    });

    const result = await requireServerAdapter("local").execute(makeContext());

    expect(result.summary).toBe("claude fallback completed");
    expect(localExecuteMock).not.toHaveBeenCalled();
    expect(claudeExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          instructionsFilePath: "/tmp/AGENTS.md",
          maxTurnsPerRun: 3,
        },
      }),
    );
  });
});
