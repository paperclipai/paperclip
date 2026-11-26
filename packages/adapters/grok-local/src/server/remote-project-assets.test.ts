import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGrokRemoteProjectAssets } from "./remote-project-assets.js";

it.each(["existing", "new", "unsafe", "changed"])("keeps %s project files safe while staging Grok runtime assets", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets"), outside = path.join(root, "outside");
    await fs.mkdir(cwd); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const stagedSkill = path.join(assets, ".claude/skills/selected");
    await fs.mkdir(stagedSkill, { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "selected skill");
    await fs.writeFile(path.join(assets, "Agents.md"), "agent instructions");
    if (scenario === "existing") {
      await fs.mkdir(path.join(cwd, ".claude/skills/own"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".claude/skills/own/keep.txt"), "user skill");
    }
    if (scenario === "unsafe") await fs.symlink(outside, path.join(cwd, ".claude"));
    const input = { runId: "fixture", target: { kind: "local" as const }, cwd, assets };
    if (scenario === "unsafe") {
      await expect(prepareGrokRemoteProjectAssets(input)).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
      return;
    }
    const prepared = await prepareGrokRemoteProjectAssets(input);
    expect(prepared.rulesFilePath).toBe(path.join(assets, "Agents.md"));
    expect(await fs.readFile(path.join(cwd, ".claude/skills/selected/SKILL.md"), "utf8")).toBe("selected skill");
    if (scenario === "changed") {
      await fs.rename(path.join(cwd, ".claude"), path.join(cwd, ".claude-original"));
      await fs.symlink(outside, path.join(cwd, ".claude"));
      await expect(prepared.cleanup()).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    } else {
      await fs.writeFile(path.join(cwd, ".claude/user.txt"), "user work");
      await prepared.cleanup();
      expect(await fs.readFile(path.join(cwd, ".claude/user.txt"), "utf8")).toBe("user work");
      await expect(fs.stat(path.join(cwd, ".claude/skills/selected"))).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "existing") expect(await fs.readFile(path.join(cwd, ".claude/skills/own/keep.txt"), "utf8")).toBe("user skill");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("copies a skill's nested files into the folder it creates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets");
    const stagedSkill = path.join(assets, ".claude/skills/nested");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(stagedSkill, "references/deep"), { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "nested skill");
    await fs.writeFile(path.join(stagedSkill, "references/deep/notes.md"), "deep notes");
    const prepared = await prepareGrokRemoteProjectAssets({ runId: "fixture", target: { kind: "local" as const }, cwd, assets });
    const copied = path.join(cwd, ".claude/skills/nested");
    expect(await fs.readFile(path.join(copied, "SKILL.md"), "utf8")).toBe("nested skill");
    expect(await fs.readFile(path.join(copied, "references/deep/notes.md"), "utf8")).toBe("deep notes");
    await prepared.cleanup();
    await expect(fs.stat(path.join(cwd, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
