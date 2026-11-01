import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertReproducibleGitFiles, verifyRemoteGitCommit } from "../services/git-workspace-restoration.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFile("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args],
  { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
  return stdout.trim();
}

describe("reconstructable worktree FETCH_HEAD", () => {
  let root: string;
  let source: string;
  let remote: string;
  let worktree: string;
  let fetchHead: string;
  let initialCommit: string;

  async function commit(value: string) {
    await fs.writeFile(path.join(source, "marker.txt"), `${value}\n`);
    await git(source, "add", "marker.txt");
    await git(source, "commit", "-m", value);
    return git(source, "rev-parse", "HEAD");
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fetch-head-")));
    source = path.join(root, "source");
    remote = path.join(root, "remote.git");
    worktree = path.join(root, "worktree");
    const base = path.join(root, "base");
    await fs.mkdir(source);
    await git(source, "init", "--initial-branch=main");
    initialCommit = await commit("A");
    await git(root, "clone", "--bare", source, remote);
    await git(root, "clone", remote, base);
    await git(base, "worktree", "add", "-b", "task", worktree, "HEAD");
    fetchHead = path.join(await git(worktree, "rev-parse", "--absolute-git-dir"), "FETCH_HEAD");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts ordinary fetched metadata already contained in the workspace HEAD", async () => {
    await git(worktree, "fetch", "origin", "main");
    expect(await fs.readFile(fetchHead, "utf8")).toContain(`${initialCommit}\t\t`);
    await expect(assertReproducibleGitFiles(worktree)).resolves.toEqual([]);
  });

  it("verifies a fetched upstream commit before discarding metadata ahead of the workspace", async () => {
    const upstream = await commit("B");
    await git(source, "push", remote, "main");
    await git(worktree, "fetch", "origin", "main");
    await git(worktree, "fetch", "--append", "origin", "main");
    const original = await fs.readFile(fetchHead);
    await expect(assertReproducibleGitFiles(worktree)).rejects.toThrow("unverified_fetched_commit");
    const verified: string[] = [];
    await expect(assertReproducibleGitFiles(worktree, undefined, {
      verifyFetchedCommit: async (sha, signal) => {
        await verifyRemoteGitCommit(remote, sha, async () => null, signal);
        verified.push(sha);
      },
    })).resolves.toEqual([]);
    expect(verified).toEqual([upstream]);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(initialCommit);
    expect(await fs.readFile(fetchHead)).toEqual(original);
  });

  it("preserves a fetched local-only commit that the configured upstream cannot restore", async () => {
    const unpublished = await commit("Unpublished");
    await git(worktree, "fetch", source, "main");
    const original = await fs.readFile(fetchHead);
    expect(await git(worktree, "rev-parse", "FETCH_HEAD")).toBe(unpublished);
    await expect(assertReproducibleGitFiles(worktree, undefined, {
      verifyFetchedCommit: (sha, signal) => verifyRemoteGitCommit(remote, sha, async () => null, signal),
    })).rejects.toThrow("could not be restored");
    expect(await fs.readFile(fetchHead)).toEqual(original);
    expect(await git(worktree, "cat-file", "-t", unpublished)).toBe("commit");
  });

  it("preserves malformed or oversized FETCH_HEAD and bounds distinct commit proofs", async () => {
    const variants = [
      { value: "operator notes\n", reason: "unsupported_worktree_fetch_head" },
      { value: `${initialCommit}\tunknown-marker\tbranch 'main'\n`, reason: "unsupported_worktree_fetch_head" },
      { value: `${initialCommit}\t\tbranch 'main'`, reason: "unsupported_worktree_fetch_head" },
      { value: `${initialCommit}\t\tbranch 'main'\0\n`, reason: "unsupported_worktree_fetch_head" },
      { value: "x".repeat(64 * 1024 + 1), reason: "unsupported_worktree_fetch_head" },
      { value: Array.from({ length: 33 }, (_, index) => `${index.toString(16).padStart(40, "0")}\t\tbranch 'main'\n`).join(""),
        reason: "worktree_fetch_head_budget" },
    ];
    for (const { value, reason } of variants) {
      await fs.writeFile(fetchHead, value);
      await expect(assertReproducibleGitFiles(worktree, undefined, {
        verifyFetchedCommit: (sha, signal) => verifyRemoteGitCommit(remote, sha, async () => null, signal),
      })).rejects.toThrow(reason);
      expect(await fs.readFile(fetchHead, "utf8")).toBe(value);
    }
  });

  it("preserves FETCH_HEAD when its path is a symlink or directory", async () => {
    await git(worktree, "fetch", "origin", "main");
    const original = await fs.readFile(fetchHead);
    const outside = path.join(root, "retained-fetch-head");
    await fs.rename(fetchHead, outside);
    await fs.symlink(outside, fetchHead);
    await expect(assertReproducibleGitFiles(worktree)).rejects.toThrow("unsupported_worktree_fetch_head");
    expect((await fs.lstat(fetchHead)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside)).toEqual(original);
    await fs.unlink(fetchHead);
    await fs.mkdir(fetchHead);
    await expect(assertReproducibleGitFiles(worktree)).rejects.toThrow("unsupported_worktree_fetch_head");
    expect((await fs.lstat(fetchHead)).isDirectory()).toBe(true);
  });
});
