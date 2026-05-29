import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectWorkspaceSkillDirectories,
  findMissingLocalSkillIds,
  normalizeGitHubSkillDirectory,
  parseSkillImportSourceInput,
  readLocalSkillImportFromDirectory,
  readLocalSkillImports,
} from "../services/company-skills.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeSkillDir(skillDir: string, name: string) {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
}

describe("company skill import source parsing", () => {
  it("parses a skills.sh command without executing shell input", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
    expect(parsed.warnings).toEqual([]);
  });

  it("parses owner/repo/skill shorthand as skills.sh-managed", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills/find-skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills/find-skills");
  });

  it("resolves skills.sh URL with org/repo/skill to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/google-labs-code/stitch-skills/design-md",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/google-labs-code/stitch-skills");
    expect(parsed.requestedSkillSlug).toBe("design-md");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/google-labs-code/stitch-skills/design-md");
  });

  it("resolves skills.sh URL with org/repo (no skill) to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/vercel-labs/skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBeNull();
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills");
  });

  it("parses skills.sh commands whose requested skill differs from the folder name", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/remotion-dev/skills --skill remotion-best-practices",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/remotion-dev/skills");
    expect(parsed.requestedSkillSlug).toBe("remotion-best-practices");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });

  it("does not set originalSkillsShUrl for owner/repo shorthand", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });
});

describe("project workspace skill discovery", () => {
  it("normalizes GitHub skill directories for blob imports and legacy metadata", () => {
    expect(normalizeGitHubSkillDirectory("retro/.", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("retro/SKILL.md", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("SKILL.md", "root-skill")).toBe("");
    expect(normalizeGitHubSkillDirectory("", "fallback-skill")).toBe("fallback-skill");
  });

  it("finds bounded skill roots under supported workspace paths", async () => {
    const workspace = await makeTempDir("paperclip-skill-workspace-");
    await writeSkillDir(workspace, "Workspace Root");
    await writeSkillDir(path.join(workspace, "skills", "find-skills"), "Find Skills");
    await writeSkillDir(path.join(workspace, ".agents", "skills", "release"), "Release");
    await writeSkillDir(path.join(workspace, "skills", ".system", "paperclip"), "Paperclip");
    await fs.writeFile(path.join(workspace, "README.md"), "# ignore\n", "utf8");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      projectId: "11111111-1111-1111-1111-111111111111",
      projectName: "Repo",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      workspaceName: "Main",
      workspaceCwd: workspace,
    });

    expect(discovered).toEqual([
      { skillDir: path.resolve(workspace), inventoryMode: "project_root" },
      { skillDir: path.resolve(workspace, ".agents", "skills", "release"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", ".system", "paperclip"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", "find-skills"), inventoryMode: "full" },
    ]);
  });

  it("limits root SKILL.md imports to skill-related support folders", async () => {
    const workspace = await makeTempDir("paperclip-root-skill-");
    await writeSkillDir(workspace, "Workspace Skill");
    await fs.mkdir(path.join(workspace, "references"), { recursive: true });
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "references", "checklist.md"), "# Checklist\n", "utf8");
    await fs.writeFile(path.join(workspace, "scripts", "run.sh"), "echo ok\n", "utf8");
    await fs.writeFile(path.join(workspace, "assets", "logo.svg"), "<svg />\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# Repo\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};\n", "utf8");

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "project_root", metadata: { sourceKind: "project_scan" } },
    );

    expect(new Set(imported.fileInventory.map((entry) => entry.path))).toEqual(new Set([
      "assets/logo.svg",
      "references/checklist.md",
      "scripts/run.sh",
      "SKILL.md",
    ]));
    expect(imported.fileInventory.map((entry) => entry.kind)).toContain("script");
    expect(imported.metadata?.sourceKind).toBe("project_scan");
  });

  it("parses inline object array items in skill frontmatter metadata", async () => {
    const workspace = await makeTempDir("paperclip-inline-skill-yaml-");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "SKILL.md"),
      [
        "---",
        "name: Inline Metadata Skill",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: paperclipai/paperclip",
        "      path: skills/paperclip",
        "---",
        "",
        "# Inline Metadata Skill",
        "",
      ].join("\n"),
      "utf8",
    );

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "full" },
    );

    expect(imported.metadata).toMatchObject({
      sourceKind: "local_path",
      sources: [
        {
          kind: "github-dir",
          repo: "paperclipai/paperclip",
          path: "skills/paperclip",
        },
      ],
    });
  });
});

describe("readLocalSkillImports — directory walks", () => {
  it("includes references/ and scripts/ when SKILL.md sits at the import root", async () => {
    const skillDir = await makeTempDir("paperclip-skill-root-");
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: root-skill\n---\n\n# root skill\n",
      "utf8",
    );
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# guide\n", "utf8");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "scripts", "tool.py"), "print('hi')\n", "utf8");

    const imports = await readLocalSkillImports(
      "44444444-4444-4444-8444-444444444444",
      skillDir,
    );

    expect(imports).toHaveLength(1);
    const inventory = imports[0]!.fileInventory.map((entry) => entry.path).sort();
    expect(inventory).toEqual([
      "SKILL.md",
      "references/guide.md",
      "scripts/tool.py",
    ]);
    expect(imports[0]!.trustLevel).toBe("scripts_executables");
  });

  it("still discovers nested SKILL.md trees with multiple skills", async () => {
    const root = await makeTempDir("paperclip-skill-nested-");
    const a = path.join(root, "skill-a");
    const b = path.join(root, "skill-b");
    await fs.mkdir(path.join(a, "references"), { recursive: true });
    await fs.writeFile(path.join(a, "SKILL.md"), "---\nname: a\n---\n\n# a\n", "utf8");
    await fs.writeFile(path.join(a, "references", "ref.md"), "# ref\n", "utf8");
    await fs.mkdir(b, { recursive: true });
    await fs.writeFile(path.join(b, "SKILL.md"), "---\nname: b\n---\n\n# b\n", "utf8");

    const imports = await readLocalSkillImports(
      "55555555-5555-4555-8555-555555555555",
      root,
    );

    expect(imports.map((skill) => skill.slug).sort()).toEqual(["a", "b"]);
    const aImport = imports.find((skill) => skill.slug === "a")!;
    expect(aImport.fileInventory.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "references/ref.md",
    ]);
    const bImport = imports.find((skill) => skill.slug === "b")!;
    expect(bImport.fileInventory.map((entry) => entry.path).sort()).toEqual(["SKILL.md"]);
  });

  it("does not let a root-level SKILL.md absorb files of nested sibling skills", async () => {
    // Mixed layout: SKILL.md at the import root AND a nested SKILL.md sub-skill.
    // The root skill's inventory must NOT include files that belong to the nested
    // skill, otherwise both skills would register the same files (double-inclusion).
    const root = await makeTempDir("paperclip-skill-mixed-root-nested-");
    await fs.writeFile(
      path.join(root, "SKILL.md"),
      "---\nname: root-skill\n---\n\n# root\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, "references"), { recursive: true });
    await fs.writeFile(path.join(root, "references", "guide.md"), "# guide\n", "utf8");
    const nested = path.join(root, "nested");
    await fs.mkdir(path.join(nested, "scripts"), { recursive: true });
    await fs.writeFile(path.join(nested, "SKILL.md"), "---\nname: nested\n---\n\n# nested\n", "utf8");
    await fs.writeFile(path.join(nested, "scripts", "tool.py"), "print('hi')\n", "utf8");

    const imports = await readLocalSkillImports(
      "66666666-6666-4666-8666-666666666666",
      root,
    );

    expect(imports.map((skill) => skill.slug).sort()).toEqual(["nested", "root-skill"]);
    const rootImport = imports.find((skill) => skill.slug === "root-skill")!;
    // Root keeps only its own files; the nested/ subtree is excluded.
    expect(rootImport.fileInventory.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    const nestedImport = imports.find((skill) => skill.slug === "nested")!;
    // Nested keeps its own files, paths still relative to its own directory.
    expect(nestedImport.fileInventory.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "scripts/tool.py",
    ]);
  });
});

describe("missing local skill reconciliation", () => {
  it("flags local-path skills whose directory was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-dir-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(skillDir, { recursive: true, force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
      {
        id: "skill-2",
        sourceType: "github",
        sourceLocator: "https://github.com/vercel-labs/agent-browser",
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });

  it("flags local-path skills whose SKILL.md file was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-file-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(path.join(skillDir, "SKILL.md"), { force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });
});
