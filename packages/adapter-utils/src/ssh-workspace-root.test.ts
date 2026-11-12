import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) =>
      file === "ssh"
        ? actual.execFile("sh", ["-c", args.at(-1)!], options, callback)
        : actual.execFile(file, args, options, callback)),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      file === "ssh"
        ? actual.spawn("sh", ["-c", args.at(-1)!], options)
        : actual.spawn(file, args, options)),
  };
});

import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const roots: string[] = [];
const exec = (file: string, args: string[]) => new Promise<{ stdout: string }>((resolve, reject) => {
  execFile(file, args, {}, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout });
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["direct", "managed"] as const)("preserves the parent repository during %s fallback workspace sync", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-workspace-root-"));
  roots.push(root);
  const parent = path.join(root, "parent");
  const localDir = path.join(parent, "instances", "project", "_default");
  const remoteDir = path.join(root, "remote");
  await mkdir(localDir, { recursive: true });
  await mkdir(remoteDir);
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
  await git(parent, ["init", "-b", "main"]);
  await git(parent, ["config", "user.name", "Paperclip Test"]);
  await git(parent, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(parent, "parent.txt"), "parent\n");
  await git(parent, ["add", "parent.txt"]);
  await git(parent, ["commit", "-m", "initial"]);
  const originalHead = await git(parent, ["rev-parse", "HEAD"]);
  await writeFile(path.join(localDir, "workspace.txt"), "local\n");
  const spec = {
    host: "fixture.invalid", username: "fixture", port: 22,
    remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
    privateKey: null, knownHosts: null, strictHostKeyChecking: true,
  };
  const managed = mode === "managed" ? await prepareRemoteManagedRuntime({
    spec, runId: "fallback-run", adapterKey: "test-adapter", workspaceLocalDir: localDir,
  }) : null;
  const prepared = managed ? null : await prepareWorkspaceForSshExecution({ spec, localDir });
  const workspaceRemoteDir = managed?.workspaceRemoteDir ?? remoteDir;
  await git(workspaceRemoteDir, ["init"]);
  await git(workspaceRemoteDir, ["config", "user.name", "Paperclip SSH"]);
  await git(workspaceRemoteDir, ["config", "user.email", "ssh@paperclip.dev"]);
  await writeFile(path.join(workspaceRemoteDir, "workspace.txt"), "remote\n");
  await git(workspaceRemoteDir, ["add", "workspace.txt"]);
  await git(workspaceRemoteDir, ["commit", "-m", "remote update"]);
  if (managed) await managed.restoreWorkspace();
  else await restoreWorkspaceFromSshExecution({ spec, localDir });
  expect(await git(parent, ["rev-parse", "HEAD"])).toBe(originalHead);
  expect(await git(parent, ["diff", "--cached", "--name-status"])).toBe("");
  expect(await readFile(path.join(parent, "parent.txt"), "utf8")).toBe("parent\n");
  expect(await readFile(path.join(localDir, "workspace.txt"), "utf8")).toBe("remote\n");
  await expect(stat(path.join(localDir, "parent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  if (prepared) expect(prepared.gitBacked).toBe(false);
}, 30_000);
