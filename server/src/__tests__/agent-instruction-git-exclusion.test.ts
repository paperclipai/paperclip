import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { instructionGitExcludeProgram } from "../services/agent-instruction-files.js";

const execFile = promisify(execFileCallback);
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-git-exclusion-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFile("git", ["-C", cwd, ...args]);
const exclude = (cwd: string) => execFile(process.execPath, ["-e", instructionGitExcludeProgram, cwd]);

async function assertPrivateFilesIgnored(cwd: string) {
  const runtime = path.join(cwd, ".paperclip-runtime");
  await fs.writeFile(path.join(runtime, "private.md"), "agent instructions");
  await git(cwd, "add", "-A");
  expect((await git(cwd, "diff", "--cached", "--name-only")).stdout).not.toContain(".paperclip-runtime");
  expect((await git(cwd, "check-ignore", "--", ".paperclip-runtime/private.md", ".paperclip-runtime/.gitignore")).stdout.trim().split("\n")).toHaveLength(2);
}

it("excludes runtime files without changing tracked ignore rules or Git metadata", async () => {
  await git(root, "init");
  await fs.writeFile(path.join(root, ".gitignore"), "keep-me\n");
  const metadata = path.join(root, ".git", "info", "exclude");
  const before = await fs.readFile(metadata, "utf8");
  await exclude(root);
  await exclude(root);
  await assertPrivateFilesIgnored(root);
  expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe("keep-me\n");
  expect(await fs.readFile(metadata, "utf8")).toBe(before);
});

it("never writes to an external gitdir selected by task-controlled metadata", async () => {
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside.git");
  await fs.mkdir(workspace);
  await git(workspace, "init", `--separate-git-dir=${outside}`);
  const metadata = path.join(outside, "info", "exclude");
  const before = await fs.readFile(metadata, "utf8");
  await exclude(workspace);
  await assertPrivateFilesIgnored(workspace);
  expect(await fs.readFile(metadata, "utf8")).toBe(before);
});

it("supports linked worktrees and nested task directories without changing the common gitdir", async () => {
  const repository = path.join(root, "repository"), worktree = path.join(root, "worktree");
  await fs.mkdir(repository);
  await git(repository, "init");
  await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial");
  await git(repository, "worktree", "add", "--detach", worktree);
  const nested = path.join(worktree, "nested");
  await fs.mkdir(nested);
  const metadata = path.join(repository, ".git", "info", "exclude");
  const before = await fs.readFile(metadata, "utf8");
  await exclude(nested);
  await assertPrivateFilesIgnored(nested);
  expect(await fs.readFile(metadata, "utf8")).toBe(before);
});

it.each(["directory", "file"])("rejects a symlink at the runtime exclusion %s", async (kind) => {
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const externalFile = path.join(outside, ".gitignore");
  await fs.writeFile(externalFile, "untouched\n");
  const runtime = path.join(workspace, ".paperclip-runtime");
  if (kind === "directory") await fs.symlink(outside, runtime);
  else {
    await fs.mkdir(runtime);
    await fs.symlink(externalFile, path.join(runtime, ".gitignore"));
  }
  await expect(exclude(workspace)).rejects.toThrow("Unsafe runtime exclusion");
  expect(await fs.readFile(externalFile, "utf8")).toBe("untouched\n");
});

it("replaces a linked ignore file without writing through its external inode", async () => {
  const externalFile = path.join(root, "outside-ignore"), workspace = path.join(root, "workspace");
  const runtime = path.join(workspace, ".paperclip-runtime");
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(externalFile, "untouched\n");
  await fs.link(externalFile, path.join(runtime, ".gitignore"));
  await exclude(workspace);
  expect(await fs.readFile(externalFile, "utf8")).toBe("untouched\n");
  expect(await fs.readFile(path.join(runtime, ".gitignore"), "utf8")).toBe("*\n");
});
