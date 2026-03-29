import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listPaperclipSkillEntries } from "@paperclipai/adapter-utils/server-utils";

const REQUIRED_WORKSPACE_PACKAGES = [
  { manifestPath: "../../../packages/db/package.json", packageName: "@paperclipai/db" },
  { manifestPath: "../../../packages/shared/package.json", packageName: "@paperclipai/shared" },
  { manifestPath: "../../../packages/adapter-utils/package.json", packageName: "@paperclipai/adapter-utils" },
  { manifestPath: "../../../packages/adapters/codex-local/package.json", packageName: "@paperclipai/adapter-codex-local" },
  { manifestPath: "../../../packages/adapters/cursor-local/package.json", packageName: "@paperclipai/adapter-cursor-local" },
  { manifestPath: "../../../packages/adapters/opencode-local/package.json", packageName: "@paperclipai/adapter-opencode-local" },
] as const;

describe("workspace package manifests", () => {
  it("keeps required workspace package manifests present and valid", async () => {
    await Promise.all(
      REQUIRED_WORKSPACE_PACKAGES.map(async ({ manifestPath, packageName }) => {
        const absolutePath = fileURLToPath(new URL(manifestPath, import.meta.url));
        const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as { name?: string };

        expect(parsed.name).toBe(packageName);
      }),
    );
  });

  it("resolves adapter-utils server-utils helpers from the workspace package", () => {
    expect(typeof listPaperclipSkillEntries).toBe("function");
  });
});
