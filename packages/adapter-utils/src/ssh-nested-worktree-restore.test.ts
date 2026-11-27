import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      file === "ssh"
        ? actual.spawn("sh", ["-c", args.at(-1)!], options)
        : actual.spawn(file, args, options)),
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) =>
      file === "ssh"
        ? actual.execFile("sh", ["-c", args.at(-1)!], options, callback)
        : actual.execFile(file, args, options, callback)),
  };
});

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import { DirectoryMergeConflict } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {}, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim());
    });
  });
}

async function createSharedCheckoutWithWorktree() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-nested-worktree-restore-"));
  roots.push(root);
  const localDir = path.join(root, "shared");
  const remoteCwd = path.join(root, "remote");
  await mkdir(remoteCwd);
  await mkdir(localDir);
  await git(localDir, ["init", "-b", "main"]);
  await writeFile(path.join(localDir, "tracked.txt"), "base\n");
  await writeFile(path.join(localDir, "removed.txt"), "remove me\n");
  await git(localDir, ["add", "tracked.txt", "removed.txt"]);
  await git(localDir, ["commit", "-m", "initial"]);
  await writeFile(path.join(localDir, ".git", "info", "exclude"), "/.paperclip/\n");
  await git(localDir, ["worktree", "add", "-b", "task", ".paperclip/worktrees/task"]);
  const worktreeDir = path.join(localDir, ".paperclip", "worktrees", "task");
  const link = await readFile(path.join(worktreeDir, ".git"), "utf8");
  const spec = {
    host: "fixture.invalid", username: "fixture", port: 22,
    remoteCwd, remoteWorkspacePath: remoteCwd,
    privateKey: null, knownHosts: null, strictHostKeyChecking: false,
  };
  return { localDir, remoteCwd, worktreeDir, link, spec };
}

describe("SSH restore of nested git worktrees", () => {
  it("keeps the .git link when restoring without a baseline", async () => {
    const { localDir, remoteCwd, worktreeDir, link, spec } = await createSharedCheckoutWithWorktree();
    await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: remoteCwd });
    await writeFile(path.join(remoteCwd, "tracked.txt"), "remote edit\n");
    await rm(path.join(remoteCwd, "removed.txt"));

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remoteCwd });

    await expect(readFile(path.join(localDir, "tracked.txt"), "utf8")).resolves.toBe("remote edit\n");
    await expect(readFile(path.join(localDir, "removed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(worktreeDir, ".git"), "utf8")).resolves.toBe(link);
    expect(await git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("task");
  }, 30_000);

  it("refuses to replace a worktree directory holding a .git link", async () => {
    const { localDir, remoteCwd, worktreeDir, link, spec } = await createSharedCheckoutWithWorktree();
    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "replace-run",
      adapterKey: "test-adapter",
      workspaceLocalDir: localDir,
    });
    const remoteWorktreeDir = path.join(prepared.workspaceRemoteDir, ".paperclip", "worktrees", "task");
    await rm(remoteWorktreeDir, { recursive: true, force: true });
    await writeFile(remoteWorktreeDir, "replaced\n");

    await expect(prepared.restoreWorkspace()).rejects.toBeInstanceOf(DirectoryMergeConflict);

    await expect(readFile(path.join(worktreeDir, ".git"), "utf8")).resolves.toBe(link);
    await expect(readFile(path.join(worktreeDir, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    expect(await git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("task");
  }, 30_000);
});
