import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  materializePath,
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
    await fs.mkdir(staleMaintainerSkill, { recursive: true });
    await fs.writeFile(path.join(runtimeSkill, "SKILL.md"), "# Runtime skill\n", "utf8");
    await fs.writeFile(path.join(customSkill, "SKILL.md"), "# Custom skill\n", "utf8");
    await fs.writeFile(path.join(staleMaintainerSkill, "SKILL.md"), "# Stale maintainer skill\n", "utf8");

    const runtimeMaterialized = await materializePath(runtimeSkill, path.join(skillsHome, "paperclip"));
    const customMaterialized = await materializePath(customSkill, path.join(skillsHome, "release-notes"));
    const staleMaterialized = await materializePath(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect(await fs.readFile(path.join(skillsHome, "paperclip", "SKILL.md"), "utf8")).toBe("# Runtime skill\n");
    expect(await fs.readFile(path.join(skillsHome, "release-notes", "SKILL.md"), "utf8")).toBe("# Custom skill\n");
    expect(runtimeMaterialized.kind).toBe(process.platform === "win32" ? "junction" : "symlink");
    expect(customMaterialized.kind).toBe(process.platform === "win32" ? "junction" : "symlink");
    expect(staleMaterialized.kind).toBe(process.platform === "win32" ? "junction" : "symlink");
  });
});
