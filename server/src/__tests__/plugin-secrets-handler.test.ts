import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

describe("createPluginSecretsHandler", () => {
  it("fails closed for plugin secret resolution until company scoping lands", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("still rejects malformed secret refs before the feature-disable guard", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});
