import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
  extractSecretRefPathsFromConfig,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

describe("extractSecretRefPathsFromConfig", () => {
  const ordinaryUuid = "11111111-1111-4111-8111-111111111111";
  const secretUuid = "77777777-7777-4777-8777-777777777777";

  it("does not classify ordinary UUID fields as secrets when a schema is declared", () => {
    const refs = extractSecretRefPathsFromConfig(
      { companyId: ordinaryUuid },
      {
        type: "object",
        properties: { companyId: { type: "string", format: "uuid" } },
      },
    );

    expect(refs.size).toBe(0);
  });

  it("extracts only schema fields explicitly annotated as secret references", () => {
    const refs = extractSecretRefPathsFromConfig(
      { companyId: ordinaryUuid, apiKey: secretUuid },
      {
        type: "object",
        properties: {
          companyId: { type: "string", format: "uuid" },
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    );

    expect([...refs.keys()]).toEqual([secretUuid]);
    expect([...refs.get(secretUuid) ?? []]).toEqual(["apiKey"]);
  });

  it("preserves legacy UUID discovery only when no schema exists", () => {
    const refs = extractSecretRefPathsFromConfig({ legacySecret: secretUuid });

    expect([...refs.keys()]).toEqual([secretUuid]);
  });
});

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
