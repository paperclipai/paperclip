import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";

describe("plugin config bridge scoping", () => {
  it("falls back to the invocation company scope for config.get when the worker omits companyId", async () => {
    const getConfig = vi.fn(async (params: { companyId?: string | null }) => ({
      scope: params.companyId ?? null,
    }));

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services: {
        config: { get: getConfig },
      } as never,
    });

    await expect(
      handlers["config.get"]({}, { invocationScope: { companyId: "company-a" } }),
    ).resolves.toEqual({ scope: "company-a" });
    expect(getConfig).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("preserves an explicit global config.get request even inside a company-scoped invocation", async () => {
    const getConfig = vi.fn(async (params: { companyId?: string | null }) => ({
      scope: params.companyId ?? null,
    }));

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services: {
        config: { get: getConfig },
      } as never,
    });

    await expect(
      handlers["config.get"]({ companyId: null }, { invocationScope: { companyId: "company-a" } }),
    ).resolves.toEqual({ scope: null });
    expect(getConfig).toHaveBeenCalledWith({ companyId: null });
  });
});
