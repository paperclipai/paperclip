import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfigsFromDirectory } from "../yaml-loader.js";
import { KNOWN_SHAPES } from "../shapes/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/src/oauth/__tests__ -> ../../../oauth-providers
const PROVIDERS_DIR = path.resolve(__dirname, "..", "..", "..", "oauth-providers");

describe("shipped provider yaml files", () => {
  it("all parse and validate via the loader", async () => {
    const configs = await loadProviderConfigsFromDirectory(PROVIDERS_DIR);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const config of configs) {
      expect(config.id).toMatch(/^[a-z0-9-]+$/);
      expect(config.displayName.length).toBeGreaterThan(0);
      expect(config.endpoints.authorize.startsWith("https://")).toBe(true);
      expect(config.endpoints.token.startsWith("https://")).toBe(true);
      expect(config.endpoints.accountInfo.startsWith("https://")).toBe(true);
    }
  });

  it("every referenced shape resolves via KNOWN_SHAPES", async () => {
    const configs = await loadProviderConfigsFromDirectory(PROVIDERS_DIR);
    for (const config of configs) {
      if (config.shape !== undefined) {
        expect(
          KNOWN_SHAPES[config.shape],
          `provider '${config.id}' references unknown shape '${config.shape}'`,
        ).toBeDefined();
      }
    }
  });

  it("provider ids are unique", async () => {
    const configs = await loadProviderConfigsFromDirectory(PROVIDERS_DIR);
    const ids = configs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
