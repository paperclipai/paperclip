import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  materializePaperclipSkillCopy,
} from "./server-utils.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-stale-skill-"));
  cleanupRoots.push(root);
  return root;
}

async function makeSource(root: string, body: string): Promise<string> {
  const source = path.join(root, "source", "sample-skill");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), body, "utf8");
  return source;
}

async function makeStaleCopy(root: string): Promise<{ source: string; target: string }> {
  const source = await makeSource(root, "STUB\n");
  const target = path.join(root, "home", "sample-skill--0a8c11691b");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await materializePaperclipSkillCopy(source, target);
  await fs.writeFile(path.join(source, "SKILL.md"), "REAL CONTENT\n", "utf8");
  return { source, target };
}

describe("ensurePaperclipSkillSymlink vs a stale materialized copy", () => {
  it("replaces a stale managed copy with a symlink to the live source", async () => {
    const root = await makeRoot();
    const { source, target } = await makeStaleCopy(root);

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("repaired");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(target)).toBe(source);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("REAL CONTENT\n");
    expect(await fs.readdir(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it("keeps the stale copy when the link cannot be created", async () => {
    const root = await makeRoot();
    const { source, target } = await makeStaleCopy(root);
    const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink"), {
      code: "EPERM",
    });

    await expect(
      ensurePaperclipSkillSymlink(source, target, async () => {
        throw eperm;
      }),
    ).rejects.toBe(eperm);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("STUB\n");
    expect(await fs.readdir(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it("keeps a link that a concurrent sync created first", async () => {
    const root = await makeRoot();
    const { source, target } = await makeStaleCopy(root);
    const eexist = Object.assign(new Error("EEXIST: file already exists, symlink"), {
      code: "EEXIST",
    });

    const result = await ensurePaperclipSkillSymlink(source, target, async (linkSource, linkTarget) => {
      await fs.symlink(linkSource, linkTarget);
      throw eexist;
    });
    expect(result).toBe("skipped");
    expect(await fs.readlink(target)).toBe(source);
    expect(await fs.readdir(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it("removes a stale copy abandoned by an interrupted repair", async () => {
    const root = await makeRoot();
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await materializePaperclipSkillCopy(source, `${target}.paperclip-stale-123-456`);
    const unrelated = path.join(root, "home", "sample-skill--0a8c11691b.paperclip-stale-notes");
    await fs.mkdir(unrelated);

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
    expect((await fs.readdir(path.dirname(target))).sort()).toEqual(
      [path.basename(target), path.basename(unrelated)].sort(),
    );
  });

  it("puts an abandoned copy back when the replacement link fails", async () => {
    const root = await makeRoot();
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await materializePaperclipSkillCopy(source, `${target}.paperclip-stale-123-456`);
    const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink"), {
      code: "EPERM",
    });

    await expect(
      ensurePaperclipSkillSymlink(source, target, async () => {
        throw eperm;
      }),
    ).rejects.toBe(eperm);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(await fs.readdir(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it("leaves a fresh managed copy alone", async () => {
    const root = await makeRoot();
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await materializePaperclipSkillCopy(source, target);

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  });

  it("leaves a non-Paperclip directory alone", async () => {
    const root = await makeRoot();
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "hand written\n", "utf8");

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("hand written\n");
  });

  it("still creates the symlink when nothing is there", async () => {
    const root = await makeRoot();
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });
});
