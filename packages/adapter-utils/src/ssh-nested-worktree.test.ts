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

async function createRepository(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await writeFile(path.join(dir, "tracked.txt"), "base\n");
  await git(dir, ["add", "tracked.txt"]);
  await git(dir, ["commit", "-m", "initial"]);
}

describe("SSH restore of nested git worktrees", () => {
  it.each([
    ["the shared checkout", ""],
    ["a project repository", ".paperclip-repositories/app"],
  ])("keeps the .git link of a worktree nested in %s", async (_label, repositoryPath) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-nested-worktree-"));
    roots.push(root);
    const localDir = path.join(root, "shared");
    const remoteCwd = path.join(root, "remote");
    await mkdir(remoteCwd);
    await createRepository(localDir);
    const repositoryDir = path.join(localDir, repositoryPath);
    if (repositoryPath) await createRepository(repositoryDir);
    await writeFile(path.join(repositoryDir, ".git", "info", "exclude"), "/.paperclip/\n");
    await git(repositoryDir, ["worktree", "add", "-b", "task", ".paperclip/worktrees/task"]);
    const worktreeDir = path.join(repositoryDir, ".paperclip", "worktrees", "task");
    const link = await readFile(path.join(worktreeDir, ".git"), "utf8");

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "fixture.invalid", username: "fixture", port: 22,
        remoteCwd, remoteWorkspacePath: remoteCwd,
        privateKey: null, knownHosts: null, strictHostKeyChecking: false,
      },
      runId: "shared-run",
      adapterKey: "test-adapter",
      workspaceLocalDir: localDir,
    });
    await writeFile(path.join(prepared.workspaceRemoteDir, repositoryPath, "tracked.txt"), "remote edit\n");
    await prepared.restoreWorkspace();

    await expect(readFile(path.join(repositoryDir, "tracked.txt"), "utf8")).resolves.toBe("remote edit\n");
    await expect(readFile(path.join(worktreeDir, ".git"), "utf8")).resolves.toBe(link);
    expect(await git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("task");
  }, 30_000);
});
