import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient } from "./sandbox-managed-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("keeps the .git link of a nested worktree when restoring a sandbox workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-nested-worktree-"));
  roots.push(root);
  const source = path.join(root, "source"), remote = path.join(root, "remote");
  await fs.mkdir(source);
  const git = (cwd: string, ...args: string[]) =>
    exec("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args]);
  await git(source, "init", "-b", "main");
  await fs.writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-qm", "fixture");
  await git(source, "worktree", "add", "-q", "-b", "task", ".paperclip/worktrees/task");
  const worktreeDir = path.join(source, ".paperclip", "worktrees", "task");
  const link = await fs.readFile(path.join(worktreeDir, ".git"), "utf8");

  const client: SandboxManagedRuntimeClient = {
    makeDir: async directory => { await fs.mkdir(directory, { recursive: true }); },
    writeFile: async (file, bytes) => { await fs.writeFile(file, Buffer.from(bytes)); },
    readFile: file => fs.readFile(file),
    listFiles: directory => fs.readdir(directory),
    remove: file => fs.rm(file, { recursive: true, force: true }),
    run: async command => { await exec("sh", ["-c", command]); },
    syncIn: async operations => {
      for (const operation of operations) {
        for (const mapping of operation.files) {
          await fs.mkdir(path.dirname(mapping.targetPath), { recursive: true });
          await fs.copyFile(mapping.sourcePath, mapping.targetPath);
        }
        for (const { command } of operation.postUploadCommands ?? []) await exec("sh", ["-c", command]);
      }
      return { operations: [] };
    },
  };
  const runtime = await prepareSandboxManagedRuntime({
    spec: { transport: "sandbox", provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
    client, adapterKey: "test", workspaceLocalDir: source,
  });
  try {
    await fs.writeFile(path.join(remote, "tracked.txt"), "remote edit\n");
    await runtime.restoreWorkspace();
  } finally { await runtime.cleanupWorkspaceSnapshot(); }

  await expect(fs.readFile(path.join(source, "tracked.txt"), "utf8")).resolves.toBe("remote edit\n");
  await expect(fs.readFile(path.join(worktreeDir, ".git"), "utf8")).resolves.toBe(link);
}, 30_000);
