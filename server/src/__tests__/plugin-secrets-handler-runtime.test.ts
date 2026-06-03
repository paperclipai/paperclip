import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getConfig: mocks.getConfig,
  }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: mocks.resolveSecretValue,
  }),
}));

import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_REQUIRE_COMPANY_MESSAGE,
} from "../services/plugin-secrets-handler.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const secretRef = "77777777-7777-4777-8777-777777777777";

const manifest = {
  instanceConfigSchema: {
    type: "object",
    properties: {
      apiKeyRef: {
        type: "string",
        format: "secret-ref",
      },
    },
  },
};

describe("createPluginSecretsHandler runtime company scoping", () => {
  beforeEach(() => {
    mocks.getConfig.mockReset();
    mocks.resolveSecretValue.mockReset();
  });

  it("fails closed when the runtime call has no company context", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId,
      manifest: manifest as never,
    });

    await expect(handler.resolve({ secretRef })).rejects.toThrow(
      PLUGIN_SECRET_REFS_REQUIRE_COMPANY_MESSAGE,
    );
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("rejects a secret ref that is not referenced by that company's plugin config", async () => {
    mocks.getConfig.mockResolvedValue({
      configJson: {
        apiKeyRef: "88888888-8888-4888-8888-888888888888",
      },
    });

    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId,
      manifest: manifest as never,
    });

    await expect(handler.resolve({ secretRef, companyId })).rejects.toThrow(
      /not referenced by this company's plugin config/i,
    );
    expect(mocks.getConfig).toHaveBeenCalledWith(pluginId, companyId);
    expect(mocks.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("resolves only through the company plugin binding context from saved config", async () => {
    mocks.getConfig.mockResolvedValue({
      configJson: {
        apiKeyRef: secretRef,
      },
    });
    mocks.resolveSecretValue.mockResolvedValue("plaintext-token");

    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId,
      manifest: manifest as never,
    });

    await expect(handler.resolve({ secretRef, companyId })).resolves.toBe("plaintext-token");
    expect(mocks.resolveSecretValue).toHaveBeenCalledWith(companyId, secretRef, "latest", {
      consumerType: "plugin",
      consumerId: pluginId,
      configPath: "apiKeyRef",
      actorType: "plugin",
      actorId: pluginId,
      pluginId,
    });
  });
});
