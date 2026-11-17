import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVerifiedNestedRepositoryBase, readLinkedNestedCheckout, removeStaleNestedRegistrations } from "./nested-repository-worktrees.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("nested repository worktrees on the host file system", () => {
  let root: string;
  let base: string;
  let repoUrl: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nested-worktrees-")));
    const author = path.join(root, "author");
    await fs.mkdir(author);
    git(author, "init", "--initial-branch=main");
    git(author, "config", "user.email", "test@example.com");
    git(author, "config", "user.name", "Test");
    await fs.writeFile(path.join(author, "file.txt"), "content\n");
    git(author, "add", ".");
    git(author, "commit", "-m", "initial");
    repoUrl = pathToFileURL(author).href;
    base = path.join(root, "base");
    git(root, "clone", repoUrl, base);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts a shared clone as the base for nested worktrees", async () => {
    expect(await isVerifiedNestedRepositoryBase(base, [base], repoUrl)).toBe(true);
  });

  it("reads a worktree of the shared clone as a linked nested checkout", async () => {
    const checkout = path.join(root, "task", "repo");
    await fs.mkdir(path.dirname(checkout));
    git(base, "worktree", "add", "-b", "task-branch", checkout);
    expect(await readLinkedNestedCheckout(checkout, [base])).toMatchObject({ checkout, base });
  });

  it("removes the registration of a worktree whose checkout is gone", async () => {
    const checkout = path.join(root, "task", "repo");
    await fs.mkdir(path.dirname(checkout));
    git(base, "worktree", "add", "-b", "task-branch", checkout);
    await fs.rm(checkout, { recursive: true, force: true });
    await removeStaleNestedRegistrations(base, checkout);
    expect(await fs.readdir(path.join(base, ".git", "worktrees")).catch(() => [])).toEqual([]);
  });
});
