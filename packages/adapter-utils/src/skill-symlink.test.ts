import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePaperclipSkillSymlink } from "./server-utils.js";

const cleanup: Array<string> = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-"));
  cleanup.push(root);
  const source = path.join(root, "catalog", "scaffold-module--6325da7e3f");
  const skillsHome = path.join(root, "skills");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(skillsHome, { recursive: true });
  return { root, source, skillsHome, target: path.join(skillsHome, "scaffold-module") };
}

afterEach(async () => {
  const roots = cleanup.splice(0);
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ensurePaperclipSkillSymlink", () => {
  it("materializes a link and is idempotent", async () => {
    const { source, target } = await makeFixture();

    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("created");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    await expect(fs.readlink(target)).resolves.toBe(source);
  });

  it("survives concurrent materialization of the same target", async () => {
    const { source, target } = await makeFixture();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => ensurePaperclipSkillSymlink(source, target)),
    );

    expect(results.filter((result) => result === "created")).toHaveLength(1);
    expect(results.every((result) => result === "created" || result === "skipped")).toBe(true);
    await expect(fs.readlink(target)).resolves.toBe(source);
  });

  it("treats EEXIST from a concurrent process as success when the link matches", async () => {
    const { source, target } = await makeFixture();

    const competingLink = async (linkSource: string, linkTarget: string) => {
      // Simulate another process winning the race between lstat and symlink.
      await fs.symlink(linkSource, linkTarget);
      const error = new Error(`EEXIST: file already exists, symlink '${linkSource}' -> '${linkTarget}'`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    };

    await expect(ensurePaperclipSkillSymlink(source, target, competingLink)).resolves.toBe("created");
    await expect(fs.readlink(target)).resolves.toBe(source);
  });

  it("still fails when EEXIST leaves a foreign occupant in place", async () => {
    const { source, target, root } = await makeFixture();
    const foreign = path.join(root, "other-skill");
    await fs.mkdir(foreign, { recursive: true });

    const conflictingLink = async (linkSource: string, linkTarget: string) => {
      await fs.symlink(foreign, linkTarget);
      const error = new Error(`EEXIST: file already exists, symlink '${linkSource}' -> '${linkTarget}'`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    };

    await expect(ensurePaperclipSkillSymlink(source, target, conflictingLink)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("self-heals a deleted link on the next call", async () => {
    const { source, target } = await makeFixture();

    await ensurePaperclipSkillSymlink(source, target);
    await fs.unlink(target);
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("created");
    await expect(fs.readlink(target)).resolves.toBe(source);
  });

  it("repairs a dangling link", async () => {
    const { source, target, root } = await makeFixture();
    const stale = path.join(root, "stale-skill");
    await fs.symlink(stale, target);

    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("repaired");
    await expect(fs.readlink(target)).resolves.toBe(source);
  });
});
