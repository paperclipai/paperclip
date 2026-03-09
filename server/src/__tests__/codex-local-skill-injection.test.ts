import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as executeModule from "@paperclipai/adapter-codex-local/server";

describe("Codex skill injection", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it("replaces broken symlinks in the Codex skills directory", async () => {
    expect(typeof executeModule.syncCodexSkills).toBe("function");

    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-skills-src-"));
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-skills-home-"));
    tempDirs.push(sourceRoot, homeRoot);

    const sourceSkill = path.join(sourceRoot, "paperclip");
    const skillsHome = path.join(homeRoot, "skills");
    const targetSkill = path.join(skillsHome, "paperclip");

    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "# Paperclip\n", "utf8");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(path.join(sourceRoot, "missing-paperclip"), targetSkill);

    const logs: string[] = [];
    await executeModule.syncCodexSkills({
      skillsDir: sourceRoot,
      skillsHome,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    const stat = await fs.lstat(targetSkill);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.realpath(targetSkill)).toBe(await fs.realpath(sourceSkill));
    expect(logs.join("")).toContain('Injected Codex skill "paperclip"');
  });
});
