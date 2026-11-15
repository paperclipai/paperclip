import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient, type SandboxSyncOperation } from "./sandbox-managed-runtime.js";
import { publishWorkspaceSeedGeneration, readWorkspaceSeedGeneration, workspaceSeedGeneration } from "./workspace-seed-cache.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";
import type { GitWorkspaceSnapshot } from "./git-workspace-sync.js";
import { prepareAdapterExecutionTargetRuntime } from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

function client(): SandboxManagedRuntimeClient {
  const sync = async (operations: SandboxSyncOperation[]) => ({ operations: await Promise.all(operations.map(async operation => {
    let bytesTransferred = 0;
    for (const file of operation.files) {
      await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
      if (file.kind === "directory") await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
      else {
        const bytes = await fs.readFile(file.sourcePath);
        await fs.writeFile(file.targetPath, bytes);
        bytesTransferred += bytes.length;
      }
    }
    for (const command of operation.postUploadCommands ?? []) await exec("sh", ["-c", command.command]);
    return { operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred };
  })) });
  return {
    makeDir: directory => fs.mkdir(directory, { recursive: true }).then(() => {}),
    writeFile: (file, bytes) => fs.writeFile(file, Buffer.from(bytes)),
    readFile: file => fs.readFile(file),
    listFiles: async directory => (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name),
    remove: file => fs.rm(file, { recursive: true, force: true }),
    run: command => exec("sh", ["-c", command]).then(() => {}),
    syncIn: sync,
    syncOut: sync,
  };
}

it.each([
  { nested: false, secondBranch: "issue/second" },
  { nested: true, secondBranch: "issue/second" },
  { nested: false, secondBranch: null },
  { nested: true, secondBranch: null },
])("reuses company seed content and restores branch identity ($nested, $secondBranch)", async ({ nested, secondBranch }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shared seed-'"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  const source = path.join(root, "source");
  const repositories = nested ? ["", ".paperclip-repositories/backend"] : [""];
  for (const relative of repositories) {
    const cwd = path.join(source, relative);
    await fs.mkdir(cwd, { recursive: true });
    await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "tracked.txt"), "committed bytes\n");
    await fs.writeFile(path.join(cwd, "deleted.txt"), "delete in host\n");
    await fs.writeFile(path.join(cwd, ".gitignore"), "secret.txt\n.paperclip-repositories/\n");
    await fs.symlink("tracked.txt", path.join(cwd, "link.txt"));
    await git(cwd, "add", ".");
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Seed");
  }
  const company = path.join(root, "company");
  const otherWorkspace = path.join(root, "other-workspace"); await fs.mkdir(otherWorkspace);
  const priorGenerations = new Set<string>();
  for (let index = 0; index < 16; index++) {
    await fs.writeFile(path.join(otherWorkspace, "file.txt"), `Other workspace ${index}\n`);
    const snapshot = await captureDirectorySnapshot(otherWorkspace);
    const generation = workspaceSeedGeneration(snapshot, null, [], "company");
    await disposeDirectorySnapshot(snapshot);
    const archive = path.join(root, `other-${index}.tar`);
    await exec("tar", ["-cf", archive, "-C", otherWorkspace, "."]);
    expect(await publishWorkspaceSeedGeneration(path.join(company, "shared-v1"), generation,
      { workspaceArchivePath: archive }, { companyDirectory: company, scope: "company" })).toBe(true);
    priorGenerations.add(generation);
  }
  const prepare = async (name: string, branch: string | null, companyDirectory = company) => {
    const host = path.join(root, name, "host"), remote = path.join(root, name, "remote");
    for (const relative of repositories) {
      const cwd = path.join(host, relative);
      await fs.mkdir(path.dirname(cwd), { recursive: true });
      await exec("git", ["clone", "--shared", "-q", path.join(source, relative), cwd]);
      await git(cwd, "checkout", "-q", ...(branch ? ["-b", branch] : ["--detach", "HEAD"]));
      await fs.writeFile(path.join(cwd, "tracked.txt"), "working-tree bytes\n");
      await fs.rm(path.join(cwd, "deleted.txt"));
      await fs.writeFile(path.join(cwd, "new.txt"), "untracked overlay\n");
      await fs.writeFile(path.join(cwd, "secret.txt"), "must stay in host\n");
    }
    const phases: string[] = [];
    const durable = path.join(root, name, "durable");
    const input: Parameters<typeof prepareSandboxManagedRuntime>[0] = {
      spec: { transport: "sandbox", provider: "filesystem", sandboxId: name, remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test", client: client(), workspaceLocalDir: host, workspaceCheckpoint: true,
      workspaceGitIndexRefresh: true,
      workspaceSeedCacheScope: "company",
      workspaceSeedCacheDirectory: path.join(companyDirectory, "shared-v1"), workspaceSeedCacheCompanyDirectory: companyDirectory,
      workspaceDurableSeed: { workspaceArchivePath: path.join(durable, "workspace.tar"), gitArchivePath: path.join(durable, "git.tar") },
      runtimeSpan: async (name, work) => { phases.push(name); return work(); },
    };
    const transport = client();
    const prepared = await prepareAdapterExecutionTargetRuntime({
      ...input, runId: name,
      target: {
        kind: "remote", transport: "sandbox", providerKey: "filesystem", remoteCwd: remote,
        runner: {
          syncIn: operations => transport.syncIn!(operations), syncOut: operations => transport.syncOut!(operations),
          execute: command => runChildProcess(name, command.command, command.args ?? [], {
            cwd: command.cwd ?? root, env: command.env ?? {}, stdin: command.stdin,
            timeoutSec: 30, graceSec: 1, onLog: command.onLog ?? (async () => {}),
          }),
        },
      },
      ...(nested ? { installCommand: "exit 1", detectCommand: "git" } : {}),
    });
    return { prepared, host, remote, phases, input };
  };
  const first = await prepare("first", "issue/first");
  const second = await prepare("second", secondBranch);
  for (const relative of repositories) {
    const cwd = path.join(second.remote, relative);
    expect(await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(secondBranch ?? "HEAD");
    expect(await git(cwd, "branch", "--list", "issue/first")).toBe("");
    expect(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("working-tree bytes\n");
    expect(await git(cwd, "diff", "--cached", "--exit-code")).toBe("");
    expect(await fs.readFile(path.join(cwd, "new.txt"), "utf8")).toBe("untracked overlay\n");
    expect(await fs.readlink(path.join(cwd, "link.txt"))).toBe("tracked.txt");
    await expect(fs.stat(path.join(cwd, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(cwd, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(first.phases).toContain("workspace.git_clone");
  expect(first.phases).toContain("workspace.git_index_refresh");
  expect(second.phases).toContain("workspace.git_index_refresh");
  expect(second.phases).not.toContain("workspace.git_clone");
  expect(second.phases).not.toContain("workspace.seed_publish");
  const generations = await fs.readdir(path.join(company, "shared-v1"));
  expect(generations).toHaveLength(17);
  const current = generations.filter(generation => !priorGenerations.has(generation));
  expect(current).toHaveLength(1);
  expect(await readWorkspaceSeedGeneration(path.join(company, "shared-v1"), current[0]!, { companyDirectory: company })).not.toBeNull();
  const recovery = path.join(root, "replacement");
  const refreshCount = second.phases.filter(phase => phase === "workspace.git_index_refresh").length;
  const recovered = await prepareSandboxManagedRuntime({
    ...second.input,
    spec: { ...second.input.spec, remoteCwd: recovery },
    workspaceInboundMode: "durable_seed",
    workspaceSeedCacheScope: undefined, workspaceSeedCacheDirectory: undefined, workspaceSeedCacheCompanyDirectory: undefined,
    workspaceBaseline: second.prepared.workspaceSyncSnapshot!.baseline,
    workspaceGitSnapshot: second.prepared.workspaceSyncSnapshot!.gitSnapshot,
  });
  expect(second.phases.filter(phase => phase === "workspace.git_index_refresh")).toHaveLength(refreshCount);
  second.remote = recovery;
  for (const relative of repositories) {
    const cwd = path.join(second.remote, relative);
    expect(await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(secondBranch ?? "HEAD");
    expect(await fs.readFile(path.join(cwd, "new.txt"), "utf8")).toBe("untracked overlay\n");
    await fs.writeFile(path.join(cwd, "tracked.txt"), "agent edit\n");
    await git(cwd, "add", "tracked.txt");
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Agent change");
  }
  await recovered.restoreWorkspace();
  for (const relative of repositories) {
    expect(await git(path.join(second.host, relative), "rev-parse", "--abbrev-ref", "HEAD")).toBe(secondBranch ?? "HEAD");
    expect(await fs.readFile(path.join(second.host, relative, "tracked.txt"), "utf8")).toBe("agent edit\n");
    expect(await fs.readFile(path.join(second.host, relative, "secret.txt"), "utf8")).toBe("must stay in host\n");
    expect(await fs.readFile(path.join(first.host, relative, "tracked.txt"), "utf8")).toBe("working-tree bytes\n");
  }
  await first.prepared.cleanupWorkspaceSnapshot?.();
  const isolated = await prepare("other-company", secondBranch, path.join(root, "other-company-cache"));
  expect(isolated.phases).toContain("workspace.git_clone");
  await isolated.prepared.cleanupWorkspaceSnapshot?.();
  await fs.writeFile(path.join(company, "shared-v1", current[0]!, "git.tar"), "corrupted cache");
  const fallback = await prepare("corrupted-cache", secondBranch);
  expect(fallback.phases).toContain("workspace.git_clone");
  for (const relative of repositories) {
    const cwd = path.join(fallback.remote, relative);
    expect(await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(secondBranch ?? "HEAD");
    expect(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("working-tree bytes\n");
    expect(await fs.readFile(path.join(cwd, "new.txt"), "utf8")).toBe("untracked overlay\n");
    await expect(fs.stat(path.join(cwd, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  await fallback.prepared.cleanupWorkspaceSnapshot?.();
}, 30_000);

it("separates shared seeds when file contents, Git head, origin or repository layout differ", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-seed-identity-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "file.txt"), "first bytes");
  const first = await captureDirectorySnapshot(root);
  const git: GitWorkspaceSnapshot = { headCommit: "a".repeat(40), branchName: "first", originUrl: "https://example.test/one.git", overlayPaths: [], deletedPaths: [], ignoredPaths: [] };
  const generation = workspaceSeedGeneration(first, git, [], "company");
  expect(workspaceSeedGeneration(first, { ...git, branchName: "second" }, [], "company")).toBe(generation);
  expect(workspaceSeedGeneration(first, git)).not.toBe(workspaceSeedGeneration(first, { ...git, branchName: "second" }));
  expect(workspaceSeedGeneration(first, { ...git, headCommit: "b".repeat(40) }, [], "company")).not.toBe(generation);
  expect(workspaceSeedGeneration(first, { ...git, originUrl: "https://example.test/two.git" }, [], "company")).not.toBe(generation);
  expect(workspaceSeedGeneration(first, git, [{ path: "nested", snapshot: git }], "company")).not.toBe(generation);
  expect(workspaceSeedGeneration(first, null, [{ path: "first", snapshot: git }], "company"))
    .not.toBe(workspaceSeedGeneration(first, null, [{ path: "second", snapshot: git }], "company"));
  await fs.writeFile(path.join(root, "file.txt"), "second bytes");
  const second = await captureDirectorySnapshot(root);
  expect(workspaceSeedGeneration(second, git, [], "company")).not.toBe(generation);
  await disposeDirectorySnapshot(first); await disposeDirectorySnapshot(second);
});

it.each([false, true])("awaits restored-index work before inbound preparation completes (failure=%s)", async failure => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-index-barrier-"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  const host = path.join(root, "host"), remote = path.join(root, "remote");
  await fs.mkdir(host);
  await git(host, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(host, "tracked.txt"), "committed\n");
  await git(host, "add", ".");
  await git(host, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Seed");
  await fs.writeFile(path.join(host, "tracked.txt"), "dirty working tree\n");
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let refreshing = false, completed = false;
  const refreshTimeouts: Array<number | undefined> = [];
  const transport = client();
  const preparing = prepareAdapterExecutionTargetRuntime({
    runId: "index-barrier", adapterKey: "test", workspaceLocalDir: host, workspaceGitIndexRefresh: true,
    target: { kind: "remote", transport: "sandbox", providerKey: "filesystem", remoteCwd: remote, timeoutMs: 45_000,
      runner: { syncIn: operations => transport.syncIn!(operations), syncOut: operations => transport.syncOut!(operations),
        execute: command => {
          if (refreshing) refreshTimeouts.push(command.timeoutMs);
          return runChildProcess("index-barrier", refreshing && failure ? "sh" : command.command,
            refreshing && failure ? ["-c", "exit 7"] : command.args ?? [], {
              cwd: command.cwd ?? root, env: command.env ?? {}, timeoutSec: (command.timeoutMs ?? 45_000) / 1000,
              graceSec: 1, onLog: async () => {},
            });
        },
      },
    },
    runtimeSpan: async (name, work) => {
      if (name !== "workspace.git_index_refresh") return work();
      enter(); await blocked; refreshing = true;
      try { return await work(); } finally { refreshing = false; }
    },
  });
  void preparing.then(() => { completed = true; }, () => {});
  try {
    await Promise.race([entered, preparing.then(() => { throw new Error("Preparation bypassed the index barrier"); })]);
    expect(await fs.readFile(path.join(remote, "tracked.txt"), "utf8")).toBe("dirty working tree\n");
    expect(completed).toBe(false);
    release();
    if (failure) await expect(preparing).rejects.toThrow();
    else {
      const prepared = await preparing;
      expect(await git(remote, "diff", "--cached", "--exit-code")).toBe("");
      expect(await git(remote, "diff", "--name-only")).toBe("tracked.txt");
      await prepared.cleanupWorkspaceSnapshot?.();
    }
    expect(refreshTimeouts).toEqual([45_000]);
  } finally {
    release();
    await preparing.catch(() => {});
  }
});
