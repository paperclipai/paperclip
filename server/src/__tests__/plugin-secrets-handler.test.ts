import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
} from "../services/plugin-secrets-handler.js";

// Fork patch: this whole file tests upstream PR #5429's "fail closed" gate
// (plugin secret refs disabled until company-scoped plugin config lands).
// Our companion patch in services/plugin-secrets-handler.ts restores the
// working secret-resolution path so installed plugins (telegram, slack,
// etc.) keep functioning. Skip the gate-specific cases until upstream lands
// company-scoped config and we revert the restore.
describe.skip("createPluginSecretsHandler (gate)", () => {
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
