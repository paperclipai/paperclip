import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
  extractSecretRefPathsFromConfig,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

describe("createPluginSecretsHandler", () => {
  it("ignores UUID-looking metadata outside schema-declared secret-ref paths", () => {
    const secretRef = "77777777-7777-4777-8777-777777777777";
    const refs = extractSecretRefPathsFromConfig(
      {
        credentials: {
          apiKey: secretRef,
        },
        metadata: {
          leakedLookingUuid: "88888888-8888-4888-8888-888888888888",
        },
      },
      {
        type: "object",
        properties: {
          credentials: {
            type: "object",
            properties: {
              apiKey: { type: "string", format: "secret-ref" },
            },
          },
          metadata: {
            type: "object",
            properties: {
              leakedLookingUuid: { type: "string" },
            },
          },
        },
      },
    );

    expect(Array.from(refs.entries())).toEqual([
      [secretRef, new Set(["credentials.apiKey"])],
    ]);
  });

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
