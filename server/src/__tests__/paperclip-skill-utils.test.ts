import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  symlinkOrCopy,
  ensurePaperclipSkillSymlink,
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

  describe("symlinkOrCopy", () => {
    it("creates a symlink for a directory", async () => {
      const root = await makeTempDir("robust-link-");
      cleanupDirs.add(root);

      const source = path.join(root, "source-dir");
      const target = path.join(root, "link");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "file.txt"), "hello");

      await symlinkOrCopy(source, target);

      const stat = await fs.lstat(target);
      expect(stat.isSymbolicLink()).toBe(true);
      const content = await fs.readFile(path.join(target, "file.txt"), "utf8");
      expect(content).toBe("hello");
    });

    it("propagates non-EPERM errors", async () => {
      const root = await makeTempDir("robust-link-err-");
      cleanupDirs.add(root);

      await expect(
        symlinkOrCopy(path.join(root, "nonexistent"), path.join(root, "sub", "deep", "link")),
      ).rejects.toThrow();
    });
  });

  describe("ensurePaperclipSkillSymlink", () => {
    it("creates a new symlink when target does not exist", async () => {
      const root = await makeTempDir("skill-symlink-create-");
      cleanupDirs.add(root);

      const source = path.join(root, "skill");
      const target = path.join(root, "link");
      await fs.mkdir(source, { recursive: true });

      const result = await ensurePaperclipSkillSymlink(source, target);
      expect(result).toBe("created");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    });

    it("repairs a broken symlink pointing to a stale location", async () => {
      const root = await makeTempDir("skill-symlink-repair-");
      cleanupDirs.add(root);

      const source = path.join(root, "skill");
      const stale = path.join(root, "stale");
      const target = path.join(root, "link");
      await fs.mkdir(source, { recursive: true });
      await fs.symlink(stale, target);

      const result = await ensurePaperclipSkillSymlink(source, target);
      expect(result).toBe("repaired");
      const linkedPath = await fs.readlink(target);
      expect(path.resolve(path.dirname(target), linkedPath)).toBe(source);
    });

    it("skips when target already points to source", async () => {
      const root = await makeTempDir("skill-symlink-skip-");
      cleanupDirs.add(root);

      const source = path.join(root, "skill");
      const target = path.join(root, "link");
      await fs.mkdir(source, { recursive: true });
      await fs.symlink(source, target);

      const result = await ensurePaperclipSkillSymlink(source, target);
      expect(result).toBe("skipped");
    });

    it("uses symlinkOrCopy as default linker", async () => {
      const root = await makeTempDir("skill-symlink-robust-");
      cleanupDirs.add(root);

      const source = path.join(root, "skill");
      const target = path.join(root, "link");
      await fs.mkdir(source, { recursive: true });

      // default linkSkill should be symlinkOrCopy
      const result = await ensurePaperclipSkillSymlink(source, target);
      expect(result).toBe("created");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    });
  });
});
