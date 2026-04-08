import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });

  it("passes through normalized opencode_local config when the model format is valid", async () => {
    secretsSvc.normalizeAdapterConfigForPersistence.mockResolvedValue({
      model: "openai/gpt-5-codex",
    });
    secretsSvc.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        model: "openai/gpt-5-codex",
      },
    });

    const result = await prepareAdapterConfigForPersistence({
      companyId: "company-1",
      adapterType: "opencode_local",
      adapterConfig: {},
      strictMode: false,
      secretsSvc,
    });

    expect(result).toEqual({ model: "openai/gpt-5-codex" });
  });
});
