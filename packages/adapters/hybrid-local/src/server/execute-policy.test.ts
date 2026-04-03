import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    claudeExecute: vi.fn(),
    codexExecute: vi.fn(),
    executeLocalModel: vi.fn(),
    testOpenAICompatAvailability: vi.fn(),
    getQuotaWindows: vi.fn(),
  };
});

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  execute: mocks.claudeExecute,
}));

vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  execute: mocks.codexExecute,
}));

vi.mock("./openai-compat.js", () => ({
  executeLocalModel: mocks.executeLocalModel,
  testOpenAICompatAvailability: mocks.testOpenAICompatAvailability,
  resolveBaseUrl: (value: unknown) =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : "http://127.0.0.1:11434/v1",
}));

vi.mock("./quota.js", () => ({
  getQuotaWindows: mocks.getQuotaWindows,
}));

describe("hybrid_local quota policy enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks Claude coding when handoff requested and allowExtraCredit=false at/over threshold", async () => {
    mocks.executeLocalModel.mockResolvedValue({
      summary: "Need code changes.\nHANDOFF: true",
      model: "qwen3-coder:latest",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      finishReason: "stop",
    });

    mocks.getQuotaWindows.mockResolvedValue({
      provider: "anthropic",
      ok: true,
      windows: [
        {
          label: "Current week (all models)",
          usedPercent: 95,
          resetsAt: null,
          valueLabel: null,
          detail: null,
        },
      ],
    });

    const { execute } = await import("./execute.js");

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
      },
      config: {
        model: "qwen3-coder:latest",
        codingModel: "claude-haiku-4-5-20251001",
        allowExtraCredit: false,
        quotaThresholdPercent: 80,
        localBaseUrl: "http://127.0.0.1:11434/v1",
      },
      context: {
        paperclipWorkspace: { cwd: process.cwd() },
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.errorCode).toBe("extra_credit_disabled");
    expect(mocks.claudeExecute).not.toHaveBeenCalled();
  });

  it("routes handoff to Codex when codingModel is non-Claude", async () => {
    mocks.getQuotaWindows.mockResolvedValue({
      provider: "anthropic",
      ok: true,
      windows: [
        {
          label: "Current week (all models)",
          usedPercent: 95,
          resetsAt: null,
          valueLabel: null,
          detail: null,
        },
      ],
    });

    mocks.executeLocalModel.mockResolvedValue({
      summary: "Need code changes.\nHANDOFF: true",
      model: "qwen3-coder:latest",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      finishReason: "stop",
    });

    mocks.codexExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { ok: true },
    });

    const { execute } = await import("./execute.js");

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
      },
      config: {
        model: "qwen3-coder:latest",
        codingModel: "codex-mini-latest",
        allowExtraCredit: false,
        quotaThresholdPercent: 80,
      },
      context: {
        paperclipWorkspace: { cwd: process.cwd() },
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(mocks.codexExecute).toHaveBeenCalledTimes(1);
    expect((result.resultJson as Record<string, unknown>)._hybrid).toEqual(
      expect.objectContaining({
        codingModel: "codex-mini-latest",
        codingBackend: "codex_cli",
        handoffRequested: true,
      }),
    );
  });
});
