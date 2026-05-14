import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

  it("reports tab indentation explicitly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oauth-provider-yaml-"));
    try {
      await writeFile(
        path.join(dir, "bad.yaml"),
        "id: bad\n\tclientCredentials:\n\t\tclientIdEnv: BAD_ID\n",
        "utf8",
      );
      await expect(loadProviderConfigsFromDirectory(dir)).rejects.toThrow(
        /Tab indentation is not supported/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
