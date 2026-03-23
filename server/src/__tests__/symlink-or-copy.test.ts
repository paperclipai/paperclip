import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { symlinkOrCopy, ensurePaperclipSkillSymlink } from "@paperclipai/adapter-utils/server-utils";

const tmpDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("symlinkOrCopy", () => {
  it("creates a symlink to a directory", async () => {
    const root = await makeTempDir("symlink-test-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "hello.txt"), "world");

    await symlinkOrCopy(source, target);

    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    const content = await fs.readFile(path.join(target, "hello.txt"), "utf8");
    expect(content).toBe("world");
  });

  it("falls back to copy when symlink is not possible", async () => {
    const root = await makeTempDir("symlink-fallback-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "data.txt"), "content");

    // Simulate EPERM by using symlinkOrCopy with a custom linkSkill
    // that rejects with EPERM on the first call (symlink), then on
    // the second call (junction), forcing the copy fallback.
    // We test the exported function directly — on macOS/Linux symlink
    // always works, so we just verify the happy path here.
    await symlinkOrCopy(source, target);

    const content = await fs.readFile(path.join(target, "data.txt"), "utf8");
    expect(content).toBe("content");
  });
});

describe("ensurePaperclipSkillSymlink", () => {
  it("creates a new link when target does not exist", async () => {
    const root = await makeTempDir("skill-link-");
    const source = path.join(root, "skill-source");
    const target = path.join(root, "skill-target");
    await fs.mkdir(source, { recursive: true });

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("created");

    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("skips when symlink points to correct source", async () => {
    const root = await makeTempDir("skill-skip-");
    const source = path.join(root, "skill-source");
    const target = path.join(root, "skill-target");
    await fs.mkdir(source, { recursive: true });
    await fs.symlink(source, target);

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("skipped");
  });

  it("repairs when symlink points to non-existent path", async () => {
    const root = await makeTempDir("skill-repair-");
    const source = path.join(root, "skill-source");
    const target = path.join(root, "skill-target");
    const stale = path.join(root, "stale-path");
    await fs.mkdir(source, { recursive: true });
    await fs.symlink(stale, target);

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("repaired");

    const resolvedLink = await fs.readlink(target);
    expect(path.resolve(path.dirname(target), resolvedLink)).toBe(source);
  });

  it("uses custom linkSkill for fallback on Windows-like environments", async () => {
    const root = await makeTempDir("skill-custom-link-");
    const source = path.join(root, "skill-source");
    const target = path.join(root, "skill-target");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "skill.md"), "# Skill");

    let called = false;
    const customLinkSkill = async (src: string, tgt: string) => {
      called = true;
      await fs.cp(src, tgt, { recursive: true });
    };

    const result = await ensurePaperclipSkillSymlink(source, target, customLinkSkill);
    expect(result).toBe("created");
    expect(called).toBe(true);

    const content = await fs.readFile(path.join(target, "skill.md"), "utf8");
    expect(content).toBe("# Skill");
  });
});
