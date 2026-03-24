import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  removeDanglingSkillSymlinks,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual(["paperclipai/paperclip/paperclip"]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual(["paperclip"]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });

  it("removes dangling symlinks whose targets no longer exist", async () => {
    const root = await makeTempDir("paperclip-dangling-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const validSkill = path.join(root, "skills", "paperclip");
    const missingSkill = path.join(root, "skills", "deleted-adapter-skill");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(validSkill, { recursive: true });
    // Do NOT create missingSkill — it simulates a removed adapter package

    await fs.symlink(validSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(missingSkill, path.join(skillsHome, "deleted-adapter-skill"));

    const removed = await removeDanglingSkillSymlinks(skillsHome);

    expect(removed).toEqual(["deleted-adapter-skill"]);
    await expect(fs.lstat(path.join(skillsHome, "deleted-adapter-skill"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("does not remove non-symlink entries or valid symlinks", async () => {
    const root = await makeTempDir("paperclip-dangling-noop-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const validSkill = path.join(root, "skills", "paperclip");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(validSkill, { recursive: true });
    await fs.mkdir(path.join(skillsHome, "regular-dir"), { recursive: true });
    await fs.symlink(validSkill, path.join(skillsHome, "paperclip"));

    const removed = await removeDanglingSkillSymlinks(skillsHome);

    expect(removed).toEqual([]);
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(path.join(skillsHome, "regular-dir"))).isDirectory()).toBe(true);
  });
});
