import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
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

  it("respects bundled skill metadata for optional company-library skills", async () => {
    const root = await makeTempDir("paperclip-skill-required-flags-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    const paperclipDir = path.join(root, "skills", "paperclip");
    const approvalGateDir = path.join(root, "skills", "approval-gate");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.mkdir(approvalGateDir, { recursive: true });
    await fs.writeFile(path.join(paperclipDir, "SKILL.md"), "---\nname: paperclip\n---\n", "utf8");
    await fs.writeFile(
      path.join(approvalGateDir, "SKILL.md"),
      [
        "---",
        "name: approval-gate",
        "metadata:",
        "  paperclip:",
        "    requiredByDefault: false",
        "---",
        "",
        "# Approval Gate",
        "",
      ].join("\n"),
      "utf8",
    );

    const entries = await listPaperclipSkillEntries(moduleDir);

    const approvalGate = entries.find((entry) => entry.key === "paperclipai/paperclip/approval-gate");
    const paperclip = entries.find((entry) => entry.key === "paperclipai/paperclip/paperclip");
    expect(approvalGate).toMatchObject({
      runtimeName: "approval-gate",
      required: false,
      requiredReason: null,
    });
    expect(paperclip).toMatchObject({
      runtimeName: "paperclip",
      required: true,
      requiredReason: "Bundled Paperclip skills are always available for local adapters.",
    });
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
});
