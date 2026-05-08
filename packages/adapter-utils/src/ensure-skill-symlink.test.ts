import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensurePaperclipSkillSymlink } from "./server-utils.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("ensurePaperclipSkillSymlink", () => {
  let tempDir: string;
  let skillsDir: string;
  let skillsHome: string;

  beforeEach(async () => {
    tempDir = await makeTempDir("paperclip-skill-test-");
    skillsDir = path.join(tempDir, "skills");
    skillsHome = path.join(tempDir, "skills-home");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(skillsHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a symlink when it does not exist", async () => {
    const source = path.join(skillsDir, "my-skill");
    await fs.mkdir(source, { recursive: true });
    const target = path.join(skillsHome, "my-skill");

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("created");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(target)).toBe(await fs.realpath(source));
  });

  it("skips if the symlink already points to the correct source", async () => {
    const source = path.join(skillsDir, "my-skill");
    await fs.mkdir(source, { recursive: true });
    const target = path.join(skillsHome, "my-skill");

    await fs.symlink(source, target);
    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("skipped");
  });

  it("repairs the symlink if it points to a different source (even if it exists)", async () => {
    const sourceA = path.join(skillsDir, "skill-a");
    const sourceB = path.join(skillsDir, "skill-b");
    await fs.mkdir(sourceA, { recursive: true });
    await fs.mkdir(sourceB, { recursive: true });
    const target = path.join(skillsHome, "my-skill");

    // Point to sourceA first
    await fs.symlink(sourceA, target);
    
    // Try to ensure it points to sourceB. 
    // This is the bug: it used to return "skipped" if sourceA existed.
    const result = await ensurePaperclipSkillSymlink(sourceB, target);
    
    expect(result).toBe("repaired");
    expect(await fs.realpath(target)).toBe(await fs.realpath(sourceB));
  });

  it("honors preserveExistingValidMismatchedLinks option", async () => {
    const sourceA = path.join(skillsDir, "skill-a");
    const sourceB = path.join(skillsDir, "skill-b");
    await fs.mkdir(sourceA, { recursive: true });
    await fs.mkdir(sourceB, { recursive: true });
    const target = path.join(skillsHome, "my-skill");

    // Point to sourceA first
    await fs.symlink(sourceA, target);
    
    // Try to ensure it points to sourceB, but with preserve option
    const result = await ensurePaperclipSkillSymlink(sourceB, target, undefined, {
      preserveExistingValidMismatchedLinks: true
    });
    
    expect(result).toBe("skipped");
    expect(await fs.realpath(target)).toBe(await fs.realpath(sourceA));
  });

  it("repairs a broken symlink", async () => {
    const source = path.join(skillsDir, "my-skill");
    await fs.mkdir(source, { recursive: true });
    const target = path.join(skillsHome, "my-skill");

    const nonExistentSource = path.join(tempDir, "does-not-exist");
    await fs.symlink(nonExistentSource, target);
    
    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("repaired");
    expect(await fs.realpath(target)).toBe(await fs.realpath(source));
  });
});
