import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectWorkspaceSkillDirectories,
  findMissingLocalSkillIds,
  normalizeGitHubSkillDirectory,
  parseSkillImportSourceInput,
  readInlineSkillImports,
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

describe("local directory skill imports", () => {
  it("includes scripts and references in inventory for root-level SKILL.md", async () => {
    const skillDir = await makeTempDir("paperclip-local-import-root-");
    await writeSkillDir(skillDir, "My Local Skill");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "scripts", "setup.sh"), "#!/bin/sh\necho ok\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# Guide\n", "utf8");

    const imported = await readLocalSkillImports(
      "44444444-4444-4444-4444-444444444444",
      skillDir,
    );

    expect(imported).toHaveLength(1);
    const paths = new Set(imported[0]!.fileInventory.map((entry) => entry.path));
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("scripts/setup.sh");
    expect(paths).toContain("references/guide.md");
  });

  it("classifies inventory kinds correctly for root-level imports", async () => {
    const skillDir = await makeTempDir("paperclip-local-import-kinds-");
    await writeSkillDir(skillDir, "Typed Skill");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "echo hi\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "notes.md"), "# Notes\n", "utf8");
    await fs.writeFile(path.join(skillDir, "assets", "icon.png"), "fake-png", "utf8");

    const imported = await readLocalSkillImports(
      "44444444-4444-4444-4444-444444444444",
      skillDir,
    );

    const byPath = new Map(imported[0]!.fileInventory.map((e) => [e.path, e.kind]));
    expect(byPath.get("SKILL.md")).toBe("skill");
    expect(byPath.get("scripts/run.sh")).toBe("script");
    expect(byPath.get("references/notes.md")).toBe("reference");
    expect(byPath.get("assets/icon.png")).toBe("asset");
  });

  it("handles nested skills alongside a root SKILL.md", async () => {
    const root = await makeTempDir("paperclip-local-import-nested-");
    await writeSkillDir(root, "Root Skill");
    await fs.mkdir(path.join(root, "references"), { recursive: true });
    await fs.writeFile(path.join(root, "references", "root-ref.md"), "# Root Ref\n", "utf8");
    await writeSkillDir(path.join(root, "sub-skill"), "Sub Skill");
    await fs.mkdir(path.join(root, "sub-skill", "scripts"), { recursive: true });
    await fs.writeFile(path.join(root, "sub-skill", "scripts", "sub.sh"), "echo sub\n", "utf8");

    const imported = await readLocalSkillImports(
      "44444444-4444-4444-4444-444444444444",
      root,
    );

    expect(imported.length).toBeGreaterThanOrEqual(2);
    const rootSkill = imported.find((s) => s.name === "Root Skill")!;
    const subSkill = imported.find((s) => s.name === "Sub Skill")!;
    expect(rootSkill).toBeDefined();
    expect(subSkill).toBeDefined();

    const rootPaths = new Set(rootSkill.fileInventory.map((e) => e.path));
    expect(rootPaths).toContain("SKILL.md");
    expect(rootPaths).toContain("references/root-ref.md");
    expect(rootPaths).not.toContain("sub-skill/SKILL.md");
    expect(rootPaths).not.toContain("sub-skill/scripts/sub.sh");

    const subPaths = new Set(subSkill.fileInventory.map((e) => e.path));
    expect(subPaths).toContain("SKILL.md");
    expect(subPaths).toContain("scripts/sub.sh");
    expect(subPaths).not.toContain("references/root-ref.md");
  });
});

describe("inline skill imports (covers GitHub/skills.sh inventory pattern)", () => {
  const COMPANY_ID = "55555555-5555-5555-5555-555555555555";

  it("includes all files for root-level SKILL.md in inline imports", () => {
    const files: Record<string, string> = {
      "SKILL.md": "---\nname: inline-skill\n---\n\n# Inline Skill\n",
      "scripts/deploy.sh": "echo deploy\n",
      "references/checklist.md": "# Checklist\n",
      "assets/logo.png": "fake-png",
    };

    const imported = readInlineSkillImports(COMPANY_ID, files);

    expect(imported).toHaveLength(1);
    const paths = new Set(imported[0]!.fileInventory.map((e) => e.path));
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("scripts/deploy.sh");
    expect(paths).toContain("references/checklist.md");
    expect(paths).toContain("assets/logo.png");
  });

  it("classifies kinds correctly for root-level inline imports", () => {
    const files: Record<string, string> = {
      "SKILL.md": "---\nname: typed-inline\n---\n\n# Typed\n",
      "scripts/run.sh": "echo ok\n",
      "references/notes.md": "# Notes\n",
      "assets/icon.svg": "<svg/>",
    };

    const imported = readInlineSkillImports(COMPANY_ID, files);

    const byPath = new Map(imported[0]!.fileInventory.map((e) => [e.path, e.kind]));
    expect(byPath.get("SKILL.md")).toBe("skill");
    expect(byPath.get("scripts/run.sh")).toBe("script");
    expect(byPath.get("references/notes.md")).toBe("reference");
    expect(byPath.get("assets/icon.svg")).toBe("asset");
  });

  it("scopes files correctly for nested SKILL.md in inline imports", () => {
    const files: Record<string, string> = {
      "my-skill/SKILL.md": "---\nname: nested-skill\n---\n\n# Nested\n",
      "my-skill/references/guide.md": "# Guide\n",
      "other-file.txt": "unrelated\n",
    };

    const imported = readInlineSkillImports(COMPANY_ID, files);

    expect(imported).toHaveLength(1);
    const paths = new Set(imported[0]!.fileInventory.map((e) => e.path));
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("references/guide.md");
    expect(paths).not.toContain("other-file.txt");
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
