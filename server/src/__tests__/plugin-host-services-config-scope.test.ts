import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getConfigExactScope: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getConfig: mocks.getConfig,
    getConfigExactScope: mocks.getConfigExactScope,
  }),
}));

import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

describe("plugin host services config scoping", () => {
  beforeEach(() => {
    mocks.getConfig.mockReset();
    mocks.getConfigExactScope.mockReset();
  });

  it("does not fall back to legacy global config for company-scoped reads", async () => {
    mocks.getConfigExactScope.mockResolvedValue(null);
    mocks.getConfig.mockResolvedValue({
      configJson: { tokenRef: "global-token-ref" },
    });

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "paperclip.example",
      createEventBusStub(),
    );

    await expect(
      services.config.get({ companyId: "company-a" }),
    ).resolves.toEqual({});
    expect(mocks.getConfigExactScope).toHaveBeenCalledWith("plugin-record-id", "company-a");
    expect(mocks.getConfig).not.toHaveBeenCalled();

    services.dispose();
  });

  it("still reads the exact global row for explicit global requests", async () => {
    mocks.getConfigExactScope.mockResolvedValue({
      configJson: { tokenRef: "global-token-ref" },
    });

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "paperclip.example",
      createEventBusStub(),
    );

    await expect(
      services.config.get({ companyId: null }),
    ).resolves.toEqual({ tokenRef: "global-token-ref" });
    expect(mocks.getConfigExactScope).toHaveBeenCalledWith("plugin-record-id", null);

    services.dispose();
  });
});
