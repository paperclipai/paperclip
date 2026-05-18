import { describe, expect, it, vi } from "vitest";
import {
  createPluginSecretsHandler,
} from "../services/plugin-secrets-handler.js";

describe("createPluginSecretsHandler", () => {
  it("resolves a configured plugin secret ref through the company secret service", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
      registry: {
        getConfig: vi.fn().mockResolvedValue({
          configJson: { telegramBotTokenRef: "77777777-7777-4777-8777-777777777777" },
        }),
      },
      secrets: {
        getById: vi.fn().mockResolvedValue({
          id: "77777777-7777-4777-8777-777777777777",
          companyId: "22222222-2222-4222-8222-222222222222",
          status: "active",
        }),
        resolveSecretValue: vi.fn().mockResolvedValue("resolved-token"),
      },
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).resolves.toBe("resolved-token");
  });

  it("rejects a valid UUID that is not present in this plugin config", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
      registry: { getConfig: vi.fn().mockResolvedValue({ configJson: {} }) },
      secrets: {
        getById: vi.fn(),
        resolveSecretValue: vi.fn(),
      },
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toThrow(/not configured for this plugin/i);
  });

  it("still rejects malformed secret refs before config lookup", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
      registry: { getConfig: vi.fn() },
      secrets: {
        getById: vi.fn(),
        resolveSecretValue: vi.fn(),
      },
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});
