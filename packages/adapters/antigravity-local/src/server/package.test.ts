import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("antigravity_local package metadata", () => {
  it("publishes runtime skill assets with the built adapter", async () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { files?: string[] };

    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "skills"]));
  });
});
