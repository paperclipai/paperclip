import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackMetadata() {
  const output = execFileSync("npm", ["pack", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const metadata = JSON.parse(output);
  if (!Array.isArray(metadata) || metadata.length === 0 || typeof metadata[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output from ${packageRoot}: ${output}`);
  }
  return metadata[0] as { filename: string; files: Array<{ path: string }> };
}

describe("skills catalog package artifacts", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.map((entry) => rm(entry, { force: true })));
    cleanup.length = 0;
  });

  it("packs dist manifest and catalog files for npm artifact consumers", () => {
    let metadata = readPackMetadata();
    cleanup.push(path.join(packageRoot, metadata.filename));

    if (!metadata.files.some((entry) => entry.path === "dist/generated/catalog.json")) {
      execFileSync("pnpm", ["--filter", "@paperclipai/skills-catalog", "build"], {
        cwd: packageRoot,
        stdio: "ignore",
      });
      metadata = readPackMetadata();
      cleanup.push(path.join(packageRoot, metadata.filename));
    }

    const paths = metadata.files.map((entry) => entry.path);

    expect(paths).toContain("dist/generated/catalog.json");
    expect(paths).toContain("generated/catalog.json");
    expect(paths).toContain("catalog/bundled/software-development/github-pr-workflow/SKILL.md");
    expect(paths).toContain("catalog/optional/browser/agent-browser/SKILL.md");
    expect(paths).toContain("package.json");
  });
});
