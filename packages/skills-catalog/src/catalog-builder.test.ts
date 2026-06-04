import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalogManifest,
  formatCatalogManifest,
  validateCatalog,
} from "./catalog-builder.js";

const tempDirs: string[] = [];

describe("skills catalog manifest", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("builds stable manifest entries from catalog skill directories", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "software-development", "github-pr-workflow", {
      frontmatter: [
        "name: GitHub PR Workflow",
        "description: Prepare pull requests and verification notes.",
        "key: paperclipai/bundled/software-development/github-pr-workflow",
        "recommendedForRoles:",
        "  - engineer",
        "tags:",
        "  - github",
        "  - pull-requests",
      ],
      files: {
        "references/checklist.md": "# Checklist\n",
      },
    });

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.manifest.skills[0]).toMatchObject({
      id: "paperclipai:bundled:software-development:github-pr-workflow",
      key: "paperclipai/bundled/software-development/github-pr-workflow",
      kind: "bundled",
      category: "software-development",
      slug: "github-pr-workflow",
      name: "GitHub PR Workflow",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      recommendedForRoles: ["engineer"],
      tags: ["github", "pull-requests"],
    });
    expect(result.manifest.skills[0]!.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(result.manifest.skills[0]!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reports frontmatter, directory, uniqueness, and inventory errors together", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "Bad_Category", "duplicate", {
      frontmatter: [
        "name: Duplicate",
        "key: paperclipai/bundled/software-development/other",
        "recommendedForRoles: engineer",
      ],
    });
    await writeSkill(packageDir, "optional", "software-development", "duplicate", {
      frontmatter: [
        "name: Duplicate Optional",
        "description: Optional duplicate slug.",
      ],
    });
    await fs.mkdir(path.join(packageDir, "catalog", "bundled", "software-development", "missing-skill"), {
      recursive: true,
    });
    await fs.mkdir(path.join(packageDir, "catalog", "misc"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "catalog", "misc", "SKILL.md"), "# Misplaced\n", "utf8");

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog/misc/SKILL.md is not under catalog/<bundled|optional>/<category>/<slug>/SKILL.md"),
        expect.stringContaining("catalog/bundled/software-development/missing-skill is missing SKILL.md"),
        expect.stringContaining("has invalid category"),
        expect.stringContaining("frontmatter must include description"),
        expect.stringContaining("key must be paperclipai/bundled/Bad_Category/duplicate"),
        expect.stringContaining("field recommendedForRoles must be an array of strings"),
        expect.stringContaining("Duplicate catalog slug \"duplicate\""),
      ]),
    );
  });

  it("detects stale generated manifests", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "software-development", "review", {
      frontmatter: [
        "name: Review",
        "description: Review implementation work.",
      ],
    });
    await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      formatCatalogManifest({
        schemaVersion: 1,
        packageName: "@paperclipai/skills-catalog",
        packageVersion: "0.3.1",
        generatedAt: "2026-05-26T00:00:00.000Z",
        skills: [],
      }),
      "utf8",
    );

    const result = await validateCatalog(packageDir);

    expect(result.errors).toContain(
      "generated/catalog.json is stale. Run pnpm --filter @paperclipai/skills-catalog build:manifest.",
    );
  });
});

async function createCatalogPackage() {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-catalog-"));
  tempDirs.push(packageDir);
  await fs.mkdir(path.join(packageDir, "catalog", "bundled"), { recursive: true });
  await fs.mkdir(path.join(packageDir, "catalog", "optional"), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ version: "0.3.1" }),
    "utf8",
  );
  return packageDir;
}

async function writeSkill(
  packageDir: string,
  kind: "bundled" | "optional",
  category: string,
  slug: string,
  options: {
    frontmatter: string[];
    files?: Record<string, string>;
  },
) {
  const skillDir = path.join(packageDir, "catalog", kind, category, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\n${options.frontmatter.join("\n")}\n---\n\nUse this skill.\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const filePath = path.join(skillDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}
