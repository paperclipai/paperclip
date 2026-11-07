import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyVerifiedGitExcludes } from "../services/git-repository-excludes.js";

let root: string, source: string, target: string;
const original = "keep-target-unchanged\n";
const exclude = (cwd: string) => path.join(cwd, ".git", "info", "exclude");

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-git-excludes-")));
  source = path.join(root, "source"); target = path.join(root, "target");
  for (const cwd of [source, target]) {
    await fs.mkdir(cwd);
    execFileSync("git", ["init", "--quiet", cwd], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
  }
  await fs.writeFile(exclude(source), "saved-recovery/\n");
  await fs.writeFile(exclude(target), original);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it.each(["hardlink", "oversized", "directory", "info-symlink", "info-file"])("rejects an unsafe source (%s) without changing the target", async kind => {
  if (kind === "hardlink") await fs.link(exclude(source), path.join(root, "linked-exclude"));
  if (kind === "oversized") await fs.writeFile(exclude(source), Buffer.alloc(1024 * 1024 + 1));
  if (kind === "directory") { await fs.rm(exclude(source)); await fs.mkdir(exclude(source)); }
  if (kind === "info-symlink" || kind === "info-file") {
    const info = path.dirname(exclude(source)), outside = path.join(root, "outside-info");
    await fs.rename(info, outside);
    if (kind === "info-symlink") await fs.symlink(outside, info);
    else await fs.writeFile(info, "not a directory\n");
  }
  await expect(copyVerifiedGitExcludes(source, target)).rejects.toThrow("unsafe_git_excludes");
  expect(await fs.readFile(exclude(target), "utf8")).toBe(original);
});

it("rejects an exclude replaced during the descriptor read", async () => {
  const replacement = path.join(root, "replacement"); await fs.writeFile(replacement, "new-source-policy/\n");
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === exclude(source)) {
      const read = handle.read.bind(handle); let changed = false;
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        const result = await Reflect.apply(read, handle, readArgs);
        if (!changed) { changed = true; await fs.rename(replacement, exclude(source)); }
        return result;
      });
    }
    return handle;
  });
  await expect(copyVerifiedGitExcludes(source, target)).rejects.toThrow("unsafe_git_excludes");
  expect(await fs.readFile(exclude(target), "utf8")).toBe(original);
  expect(await fs.readFile(exclude(source), "utf8")).toBe("new-source-policy/\n");
});
