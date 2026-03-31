import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    claudeExecute: vi.fn(),
    executeLocalModel: vi.fn(),
    testOpenAICompatAvailability: vi.fn(),
    getQuotaWindows: vi.fn(),
  };
});

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  execute: mocks.claudeExecute,
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

  it("blocks Claude fallback when local fails and allowExtraCredit=false at/over threshold", async () => {
    mocks.testOpenAICompatAvailability.mockResolvedValue({
      available: true,
      models: ["qwen3-coder:latest"],
    });

    // Resource-style local failure so fallback path is considered.
    mocks.executeLocalModel.mockRejectedValue(new Error("503 Service Unavailable"));

    // Quota exhausted => policy should block Claude fallback.
    mocks.getQuotaWindows.mockResolvedValue({
      provider: "anthropic",
      ok: true,
      windows: [
        {
          label: "Current week (all models)",
          usedPercent: 100,
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
        fallbackModel: "claude-haiku-4-5-20251001",
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
    expect(String(result.errorMessage ?? "")).toContain("Claude fallback is blocked by quota policy");
    expect(mocks.claudeExecute).not.toHaveBeenCalled();
  });
});

