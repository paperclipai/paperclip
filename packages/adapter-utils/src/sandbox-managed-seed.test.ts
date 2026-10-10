import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createTarballFromDirectory, prepareSandboxManagedRuntime, type SandboxSyncOperation } from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each([undefined, "all"] as const)("keeps nested Git metadata sanitized in cold, cached and recovered seeds (file mode %s)", async (workspaceFileMode) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "managed-seed-sanitized-")); roots.push(temp);
  vi.stubEnv("PAPERCLIP_HOME", path.join(temp, "home"));
  const host = path.join(temp, "host"), remote = path.join(temp, "remote"), cache = path.join(temp, "cache");
  const relative = ".paperclip-repositories/fixture";
  const repository = path.join(host, relative); await fs.mkdir(repository, { recursive: true });
  const git = async (root: string, ...args: string[]) => (await execute("git", ["-C", root, ...args])).stdout.trim();
  await git(repository, "init", "-b", "main");
  await fs.writeFile(path.join(repository, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(repository, "work.txt"), "first\n");
  if (workspaceFileMode === "all") {
    await fs.writeFile(path.join(repository, "notes.txt"), "keep after untracking\n");
    await fs.writeFile(path.join(repository, "absent.txt"), "truly deleted\n");
  }
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "first");
  await git(repository, "branch", "private-fixture");
  await fs.writeFile(path.join(repository, "work.txt"), "committed\n");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "selected");
  const head = await git(repository, "rev-parse", "HEAD");
  await git(repository, "remote", "add", "origin", "https://fixture-user:fixture-token@example.test/repository.git");
  await fs.writeFile(path.join(repository, ".git/hooks/post-commit"), "private-hook-fixture");
  await fs.writeFile(path.join(repository, "work.txt"), "dirty\n");
  await fs.writeFile(path.join(repository, "ignored.txt"), "ordinary ignored bytes");
  if (workspaceFileMode === "all") {
    await git(repository, "rm", "--cached", "notes.txt");
    await fs.unlink(path.join(repository, "absent.txt"));
  }
  const run = async (command: string) => { await execute("sh", ["-c", command]); };
  const sync = async (operations: SandboxSyncOperation[]) => {
    for (const operation of operations) {
      for (const file of operation.files) {
        await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
        await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
        // Optional verification scratch must be gone before required upload.
        if (file.sourcePath.endsWith("/workspace.tar")) {
          await expect(fs.stat(path.join(path.dirname(file.sourcePath), "verify-seed"))).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      for (const command of operation.postUploadCommands ?? []) await run(command.command);
    }
    return { operations: operations.map(operation => ({ operationId: operation.operationId, filesTransferred: 0, bytesTransferred: 0 })) };
  };
  const client = { makeDir: (dir: string) => fs.mkdir(dir, { recursive: true }).then(() => {}), run,
    writeFile: (file: string, data: ArrayBuffer) => fs.writeFile(file, Buffer.from(data)), readFile: (file: string) => fs.readFile(file),
    listFiles: (dir: string) => fs.readdir(dir), remove: (file: string) => fs.rm(file, { force: true, recursive: true }), syncIn: sync, syncOut: sync };
  const seed = { workspaceArchivePath: path.join(temp, "run-workspace.tar"), gitArchivePath: path.join(temp, "run-git.tar") };
  let verifications = 0;
  const prepare = (overrides: Partial<Parameters<typeof prepareSandboxManagedRuntime>[0]> = {}) => prepareSandboxManagedRuntime({
    spec: { provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30000, apiKey: null, transport: "sandbox" },
    adapterKey: "test", client, workspaceLocalDir: host, workspaceFileMode, workspaceSeedCacheDirectory: cache,
    workspaceDurableSeed: seed, runtimeSpan: async (name, work) => { if (name === "seed.verify") verifications++; return work(); }, ...overrides,
  });
  const assertSanitized = async () => {
    const checkout = path.join(remote, relative);
    expect(await git(checkout, "remote", "get-url", "origin")).toBe("https://example.test/repository.git");
    expect(await fs.readFile(path.join(checkout, ".git/config"), "utf8")).not.toContain("fixture-token");
    await expect(fs.stat(path.join(checkout, ".git/hooks/post-commit"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(git(checkout, "rev-parse", "--verify", "refs/heads/private-fixture")).rejects.toThrow();
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(await git(checkout, "show", "HEAD:work.txt")).toBe("committed");
    expect(await fs.readFile(path.join(checkout, "work.txt"), "utf8")).toBe("dirty\n");
    if (workspaceFileMode === "all") {
      expect(await fs.readFile(path.join(checkout, "ignored.txt"), "utf8")).toBe("ordinary ignored bytes");
      expect(await fs.readFile(path.join(checkout, "notes.txt"), "utf8")).toBe("keep after untracking\n");
      await expect(fs.stat(path.join(checkout, "absent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  };
  const cold = await prepare(); await assertSanitized();
  expect([...cold.workspaceSyncSnapshot!.baseline.entries].some(([key]) => key.startsWith(`${relative}/.git/`))).toBe(false);
  expect(await fs.readdir(cache)).toHaveLength(1); expect(verifications).toBe(1);
  await cold.cleanupWorkspaceSnapshot();
  await fs.writeFile(path.join(repository, ".git/hooks/post-commit"), "changed private hook");
  const cached = await prepare(); await assertSanitized(); expect(verifications).toBe(1);
  // Older descriptors may include raw metadata in their immutable overlay/baseline.
  const oldBaseline = await captureDirectorySnapshot(host, { diskBacked: true });
  await createTarballFromDirectory({ localDir: host, archivePath: seed.workspaceArchivePath });
  const recovered = await prepare({ workspaceInboundMode: "durable_seed", workspaceBaseline: oldBaseline,
    workspaceGitSnapshot: null, workspaceRepositories: cached.workspaceSyncSnapshot!.repositories });
  await assertSanitized();
  expect([...recovered.workspaceSyncSnapshot!.baseline.entries].some(([key]) => key.startsWith(`${relative}/.git/`))).toBe(false);
  const remoteRepository = path.join(remote, relative);
  await fs.writeFile(path.join(remoteRepository, "work.txt"), "remote commit\n");
  await git(remoteRepository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "remote commit");
  const remoteHead = await git(remoteRepository, "rev-parse", "HEAD");
  await fs.writeFile(path.join(remoteRepository, "work.txt"), "restored dirty bytes\n");
  if (workspaceFileMode === "all") await fs.writeFile(path.join(remoteRepository, "ignored.txt"), "updated ordinary ignored bytes");
  await recovered.restoreWorkspace();
  expect(await git(repository, "rev-parse", "HEAD")).toBe(remoteHead);
  expect(await fs.readFile(path.join(repository, "work.txt"), "utf8")).toBe("restored dirty bytes\n");
  expect(await fs.readFile(path.join(repository, ".git/config"), "utf8")).toContain("fixture-token");
  expect(await fs.readFile(path.join(repository, ".git/hooks/post-commit"), "utf8")).toBe("changed private hook");
  if (workspaceFileMode === "all") {
    expect(await fs.readFile(path.join(repository, "ignored.txt"), "utf8")).toBe("updated ordinary ignored bytes");
    expect(await fs.readFile(path.join(repository, "notes.txt"), "utf8")).toBe("keep after untracking\n");
    await expect(fs.stat(path.join(repository, "absent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  await recovered.cleanupWorkspaceSnapshot(); await cached.cleanupWorkspaceSnapshot();
}, 30000);
