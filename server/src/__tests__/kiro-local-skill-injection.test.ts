import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureKiroSkillsInjected } from "@paperclipai/adapter-kiro-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Create a mock Paperclip repo layout with skills.
 *
 * listPaperclipSkillEntries walks up from moduleDir looking for a `skills/`
 * directory at `../../skills` relative to moduleDir. We create the directory
 * structure to satisfy that resolution.
 */
async function createSkillSource(root: string, skillName: string, content: string) {
  const skillDir = path.join(root, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
}

describe("kiro local adapter skill injection", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("writes Paperclip skills as SKILL.md files with YAML frontmatter", async () => {
    const root = await makeTempDir("paperclip-kiro-skills-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-skills-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    // moduleDir is at root/a/b so ../../skills resolves to root/skills
    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nInteract with Paperclip.");
    await createSkillSource(root, "paperclip-create-agent", "# Create Agent\n\nCreate new agents.");

    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    // Verify skills were written as SKILL.md files (not symlinks)
    const skillFileA = path.join(skillsHome, "paperclip", "SKILL.md");
    const skillFileB = path.join(skillsHome, "paperclip-create-agent", "SKILL.md");
    const contentA = await fs.readFile(skillFileA, "utf8");
    const contentB = await fs.readFile(skillFileB, "utf8");

    // Check YAML frontmatter structure
    expect(contentA).toMatch(/^---\nname: paperclip\ndescription: /);
    expect(contentA).toContain("Interact with Paperclip.");
    expect(contentB).toMatch(/^---\nname: paperclip-create-agent\ndescription: /);
    expect(contentB).toContain("Create new agents.");

    // Check managed marker exists
    const markerA = path.join(skillsHome, "paperclip", ".paperclip-managed");
    const markerB = path.join(skillsHome, "paperclip-create-agent", ".paperclip-managed");
    expect(await fs.stat(markerA).then(() => true)).toBe(true);
    expect(await fs.stat(markerB).then(() => true)).toBe(true);

    // Check injection was logged
    expect(logs.some((line) => line.includes("Injected Kiro skill: paperclip"))).toBe(true);
    expect(logs.some((line) => line.includes("Injected Kiro skill: paperclip-create-agent"))).toBe(true);
  });

  it("skips user-owned skills that are not Paperclip-managed", async () => {
    const root = await makeTempDir("paperclip-kiro-preserve-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-preserve-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nContent.");

    // Create a user-owned skill at the same path (no managed marker)
    const userSkillDir = path.join(skillsHome, "paperclip");
    await fs.mkdir(userSkillDir, { recursive: true });
    await fs.writeFile(path.join(userSkillDir, "SKILL.md"), "user content", "utf8");

    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    // User's skill should be preserved
    const content = await fs.readFile(path.join(userSkillDir, "SKILL.md"), "utf8");
    expect(content).toBe("user content");
    expect(logs.some((line) => line.includes("already exists and is not Paperclip-managed"))).toBe(true);
  });

  it("skips unchanged managed skills on re-injection", async () => {
    const root = await makeTempDir("paperclip-kiro-skip-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-skip-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nContent.");

    // First injection
    await ensureKiroSkillsInjected(async () => {}, { skillsHome, moduleDir });

    // Second injection should skip (no "Injected" log)
    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    expect(logs.some((line) => line.includes("Injected Kiro skill"))).toBe(false);
  });

  it("namespaces skill directories by company prefix", async () => {
    const root = await makeTempDir("paperclip-kiro-ns-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-ns-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nInteract with Paperclip.");

    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir, companyPrefix: "dem" },
    );

    // Directory must be namespaced as "dem--paperclip"
    const namespacedDir = path.join(skillsHome, "dem--paperclip");
    const skillFile = path.join(namespacedDir, "SKILL.md");
    const content = await fs.readFile(skillFile, "utf8");

    // SKILL.md frontmatter name stays unprefixed
    expect(content).toMatch(/^---\nname: paperclip\ndescription: /);
    expect(content).toContain("Interact with Paperclip.");

    // Managed marker exists under namespaced dir
    const marker = path.join(namespacedDir, ".paperclip-managed");
    expect(await fs.stat(marker).then(() => true)).toBe(true);

    // Un-namespaced dir must NOT exist
    const unprefixedDir = path.join(skillsHome, "paperclip");
    expect(await fs.stat(unprefixedDir).then(() => true).catch(() => false)).toBe(false);

    expect(logs.some((line) => line.includes("Injected Kiro skill: paperclip"))).toBe(true);
  });

  it("concurrent runs do not clobber each other's skills", async () => {
    const root = await makeTempDir("paperclip-kiro-concurrent-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-concurrent-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip\n\nSkill content.");
    await createSkillSource(root, "paperclip-create-agent", "# Create Agent\n\nCreate agents.");

    // Simulate two agents running concurrently by calling ensureKiroSkillsInjected in parallel
    const logsA: string[] = [];
    const logsB: string[] = [];
    await Promise.all([
      ensureKiroSkillsInjected(
        async (_stream, chunk) => { logsA.push(chunk); },
        { skillsHome, moduleDir },
      ),
      ensureKiroSkillsInjected(
        async (_stream, chunk) => { logsB.push(chunk); },
        { skillsHome, moduleDir },
      ),
    ]);

    // Both agents see skills injected or up-to-date — neither throws
    const skillFileA = path.join(skillsHome, "paperclip", "SKILL.md");
    const skillFileB = path.join(skillsHome, "paperclip-create-agent", "SKILL.md");

    const contentA = await fs.readFile(skillFileA, "utf8");
    const contentB = await fs.readFile(skillFileB, "utf8");

    // Skills are intact — not empty, not corrupted
    expect(contentA).toContain("Skill content.");
    expect(contentB).toContain("Create agents.");

    // Managed markers are present for both skills
    const markerA = path.join(skillsHome, "paperclip", ".paperclip-managed");
    const markerB = path.join(skillsHome, "paperclip-create-agent", ".paperclip-managed");
    expect(await fs.stat(markerA).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(markerB).then(() => true).catch(() => false)).toBe(true);
  });

  it("does not delete another company's managed skills during pruning", async () => {
    const root = await makeTempDir("paperclip-kiro-crossco-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-crossco-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nInteract with Paperclip.");

    // Inject skills for company A (prefix "a")
    await ensureKiroSkillsInjected(async () => {}, {
      skillsHome,
      moduleDir,
      companyPrefix: "a",
    });

    // Inject skills for company B (prefix "b")
    await ensureKiroSkillsInjected(async () => {}, {
      skillsHome,
      moduleDir,
      companyPrefix: "b",
    });

    // Both companies' skills exist
    expect(await fs.stat(path.join(skillsHome, "a--paperclip", "SKILL.md")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(path.join(skillsHome, "b--paperclip", "SKILL.md")).then(() => true).catch(() => false)).toBe(true);

    // Re-run company A injection — company B's skills must survive
    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => { logs.push(chunk); },
      { skillsHome, moduleDir, companyPrefix: "a" },
    );

    // Company B's skills must NOT be deleted
    expect(await fs.stat(path.join(skillsHome, "b--paperclip", "SKILL.md")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(path.join(skillsHome, "b--paperclip", ".paperclip-managed")).then(() => true).catch(() => false)).toBe(true);

    // Company A's skills still present
    expect(await fs.stat(path.join(skillsHome, "a--paperclip", "SKILL.md")).then(() => true).catch(() => false)).toBe(true);

    // No pruning log for company B's skills
    expect(logs.some((line) => line.includes("b--paperclip"))).toBe(false);
  });

  it("prunes stale skills only within the same company prefix", async () => {
    const root = await makeTempDir("paperclip-kiro-prune-prefix-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-prune-prefix-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    // Create two skills
    await createSkillSource(root, "paperclip", "# Paperclip\n\nContent.");
    await createSkillSource(root, "old-skill", "# Old\n\nWill be removed.");

    // Inject both for company "x"
    await ensureKiroSkillsInjected(async () => {}, { skillsHome, moduleDir, companyPrefix: "x" });
    expect(await fs.stat(path.join(skillsHome, "x--old-skill", "SKILL.md")).then(() => true).catch(() => false)).toBe(true);

    // Remove old-skill from source, re-inject
    await fs.rm(path.join(root, "skills", "old-skill"), { recursive: true });
    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => { logs.push(chunk); },
      { skillsHome, moduleDir, companyPrefix: "x" },
    );

    // old-skill should be pruned
    expect(await fs.stat(path.join(skillsHome, "x--old-skill")).then(() => true).catch(() => false)).toBe(false);
    expect(logs.some((line) => line.includes('Pruned stale Kiro skill "x--old-skill"'))).toBe(true);
  });

  it("injected skills are discoverable at top-level skillsHome paths", async () => {
    const root = await makeTempDir("paperclip-kiro-discovery-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-discovery-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nInteract with Paperclip.");
    await createSkillSource(root, "paperclip-create-agent", "# Create Agent\n\nCreate new agents.");

    // Inject with a company prefix
    await ensureKiroSkillsInjected(async () => {}, {
      skillsHome,
      moduleDir,
      companyPrefix: "dem",
    });

    // Kiro discovers skills by scanning top-level subdirectories of skillsHome
    // for SKILL.md files. Verify ALL injected skills are direct children of
    // skillsHome (no nested subdirectories) and contain valid SKILL.md files.
    const topLevelEntries = await fs.readdir(skillsHome, { withFileTypes: true });
    const skillDirs = topLevelEntries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Skills should be at skillsHome/<prefix>--<name>/ (flat, not nested)
    expect(skillDirs).toContain("dem--paperclip");
    expect(skillDirs).toContain("dem--paperclip-create-agent");

    // Each skill directory must have a SKILL.md directly inside (one level deep)
    for (const dirName of skillDirs) {
      const skillMdPath = path.join(skillsHome, dirName, "SKILL.md");
      const stat = await fs.stat(skillMdPath);
      expect(stat.isFile()).toBe(true);

      // Verify SKILL.md has valid YAML frontmatter (Kiro requires this)
      const content = await fs.readFile(skillMdPath, "utf8");
      expect(content).toMatch(/^---\nname: /);
      expect(content).toMatch(/\ndescription: /);
      expect(content).toMatch(/\n---\n/);
    }

    // There must be NO nested company-prefix subdirectory
    // (i.e., skillsHome/dem/ must NOT exist as a directory containing skills)
    const companySubdir = path.join(skillsHome, "dem");
    const companySubdirExists = await fs.stat(companySubdir).then(() => true).catch(() => false);
    expect(companySubdirExists).toBe(false);
  });

  it("handles missing skills directory gracefully", async () => {
    const root = await makeTempDir("paperclip-kiro-empty-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-empty-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    // moduleDir without any skills directory
    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    // Should not throw
    await ensureKiroSkillsInjected(async () => {}, { skillsHome, moduleDir });
  });
});
