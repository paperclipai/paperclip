import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfigsFromDirectory } from "../yaml-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, "fixtures", "oauth-providers");

describe("loadProviderConfigsFromDirectory", () => {
  it("loads and validates yaml files", async () => {
    const configs = await loadProviderConfigsFromDirectory(FIXTURE_DIR);
    expect(configs.map((c) => c.id)).toContain("mock");
  });

  it("returns empty array for missing dir", async () => {
    const configs = await loadProviderConfigsFromDirectory(
      "/nonexistent/path/x",
    );
    expect(configs).toEqual([]);
  });
});
