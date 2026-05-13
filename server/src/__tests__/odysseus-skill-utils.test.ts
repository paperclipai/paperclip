import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOdysseusSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@odysseus/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("odysseus skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists bundled runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("odysseus-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "odysseus"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "odysseus-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });

    const entries = await listOdysseusSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "PossibLaw/odysseus/odysseus",
      "PossibLaw/odysseus/odysseus-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "odysseus",
      "odysseus-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "odysseus"));
    expect(entries[1]?.source).toBe(path.join(root, "skills", "odysseus-create-agent"));
  });

  it("marks skills with required: false in SKILL.md frontmatter as optional", async () => {
    const root = await makeTempDir("odysseus-skill-optional-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });

    // Required skill (no frontmatter flag)
    const requiredDir = path.join(root, "skills", "odysseus");
    await fs.mkdir(requiredDir, { recursive: true });
    await fs.writeFile(path.join(requiredDir, "SKILL.md"), "---\nname: odysseus\n---\n\n# Odysseus\n");

    // Optional skill (required: false)
    const optionalDir = path.join(root, "skills", "odysseus-dev");
    await fs.mkdir(optionalDir, { recursive: true });
    await fs.writeFile(path.join(optionalDir, "SKILL.md"), "---\nname: odysseus-dev\nrequired: false\n---\n\n# Dev\n");

    const entries = await listOdysseusSkillEntries(moduleDir);
    entries.sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.runtimeName).toBe("odysseus");
    expect(entries[0]?.required).toBe(true);
    expect(entries[1]?.runtimeName).toBe("odysseus-dev");
    expect(entries[1]?.required).toBe(false);
    expect(entries[1]?.requiredReason).toBeNull();
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("odysseus-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "odysseus");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "odysseus"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["odysseus"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "odysseus"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });
});
