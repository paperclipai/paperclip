import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("antigravity_local package metadata", () => {
  it("publishes runtime skill assets with the built adapter", async () => {
    const packageRootUrl = new URL("../../", import.meta.url);
    const packageJsonPath = fileURLToPath(new URL("package.json", packageRootUrl));
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { files?: string[] };

    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "skills"]));
    expect(await fs.readdir(new URL("skills/", packageRootUrl))).toEqual(
      expect.arrayContaining(["paperclip", "paperclip-create-agent"]),
    );
    await expect(fs.readFile(new URL("skills/paperclip/SKILL.md", packageRootUrl), "utf8")).resolves.toContain(
      "# Paperclip Skill",
    );
  });
});
