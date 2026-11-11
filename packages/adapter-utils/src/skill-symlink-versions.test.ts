import { mkdtemp, mkdir, readlink, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePaperclipSkillSymlink } from "./server-utils.js";

let root: string;

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-"));
  const versions = path.join(root, "skills", "company-1", "__versions__");
  const oldVersion = path.join(versions, "skill-a", "v1");
  const newVersion = path.join(versions, "skill-a", "v2");
  const otherSkill = path.join(versions, "skill-b", "v1");
  for (const dir of [oldVersion, newVersion, otherSkill]) await mkdir(dir, { recursive: true });
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  return { oldVersion, newVersion, otherSkill, target: path.join(home, "skill-a--1234") };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("ensurePaperclipSkillSymlink with company skill versions", () => {
  it("re-points a link that targets an older version of the same skill", async () => {
    const { oldVersion, newVersion, target } = await setup();
    await symlink(oldVersion, target);
    await expect(ensurePaperclipSkillSymlink(newVersion, target)).resolves.toBe("repaired");
    expect(await readlink(target)).toBe(newVersion);
  });

  it("keeps a link that already targets the current version", async () => {
    const { newVersion, target } = await setup();
    await symlink(newVersion, target);
    await expect(ensurePaperclipSkillSymlink(newVersion, target)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(newVersion);
  });

  it("does not touch a link to another skill", async () => {
    const { otherSkill, newVersion, target } = await setup();
    await symlink(otherSkill, target);
    await expect(ensurePaperclipSkillSymlink(newVersion, target)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(otherSkill);
  });

  it("does not touch a real directory", async () => {
    const { newVersion, target } = await setup();
    await mkdir(target);
    await expect(ensurePaperclipSkillSymlink(newVersion, target)).resolves.toBe("skipped");
  });

  it("does not re-point an existing link when the source is not a versioned skill", async () => {
    const { target } = await setup();
    const plainSource = path.join(root, "plain", "skill-a");
    const plainSibling = path.join(root, "plain", "skill-x");
    await mkdir(plainSource, { recursive: true });
    await mkdir(plainSibling, { recursive: true });
    await symlink(plainSibling, target);
    await expect(ensurePaperclipSkillSymlink(plainSource, target)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(plainSibling);
  });
});
