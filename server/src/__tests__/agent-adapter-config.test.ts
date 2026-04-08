import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
}));

const { prepareAdapterConfigForPersistence } = await import("../services/agent-adapter-config.js");

describe("agent adapter config validation", () => {
  const secretsSvc = {
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects opencode_local configs without an explicit provider/model", async () => {
    secretsSvc.normalizeAdapterConfigForPersistence.mockResolvedValue({});
    secretsSvc.resolveAdapterConfigForRuntime.mockResolvedValue({ config: {} });

    await expect(
      prepareAdapterConfigForPersistence({
        companyId: "company-1",
        adapterType: "opencode_local",
        adapterConfig: {},
        strictMode: false,
        secretsSvc,
      }),
    ).rejects.toThrow("OpenCode requires an explicit model in provider/model format.");

    expect(mockEnsureOpenCodeModelConfiguredAndAvailable).not.toHaveBeenCalled();
  });

  it("passes through normalized opencode_local config when the model is available", async () => {
    secretsSvc.normalizeAdapterConfigForPersistence.mockResolvedValue({
      model: "openai/gpt-5-codex",
    });
    secretsSvc.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        model: "openai/gpt-5-codex",
        command: "opencode",
        cwd: "/tmp/workspace",
        env: {},
      },
    });
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue([]);

    const result = await prepareAdapterConfigForPersistence({
      companyId: "company-1",
      adapterType: "opencode_local",
      adapterConfig: {},
      strictMode: false,
      secretsSvc,
    });

    expect(result).toEqual({ model: "openai/gpt-5-codex" });
    expect(mockEnsureOpenCodeModelConfiguredAndAvailable).toHaveBeenCalledWith({
      model: "openai/gpt-5-codex",
      command: "opencode",
      cwd: "/tmp/workspace",
      env: {},
    });
  });
});
