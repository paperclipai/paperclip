import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInsideGitRepo } from "./git-repo.js";

describe("isInsideGitRepo", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("returns false for fallback workspaces outside git repos", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-fallback-"));
    const workspace = path.join(root, "workspace");
    cleanupDirs.add(root);
    await fs.mkdir(workspace, { recursive: true });

    await expect(isInsideGitRepo(workspace)).resolves.toBe(false);
  });

  it("returns true for directories inside a git repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-repo-"));
    const workspace = path.join(root, "workspace", "nested");
    cleanupDirs.add(root);
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    await expect(isInsideGitRepo(workspace)).resolves.toBe(true);
  });

  it("treats worktree-style .git files as git repositories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-worktree-"));
    const workspace = path.join(root, "workspace");
    cleanupDirs.add(root);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /tmp/worktrees/demo\n", "utf8");

    await expect(isInsideGitRepo(workspace)).resolves.toBe(true);
  });
});
