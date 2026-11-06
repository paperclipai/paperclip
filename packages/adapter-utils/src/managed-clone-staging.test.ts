import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeGitWorkspaceSnapshot,
  listProjectRepositoryStagingPaths,
  readGitWorkspaceSnapshot,
  type GitWorkspaceSnapshot,
} from "./git-workspace-sync.js";
import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "./sandbox-managed-runtime.js";
import { listLocalProjectRepositories } from "./ssh.js";
import { workspacePaths } from "./workspace-manifest.js";

const execFile = promisify(execFileCallback);
const STAGING_PATH = ".paperclip-repositories/backend.clone-Ab12Cd";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function createRepo(cwd: string, contents: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Paperclip Test"]);
  await git(cwd, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(cwd, "README.md"), contents);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", contents]);
}

function makeFilesystemClient(): SandboxManagedRuntimeClient {
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => {
      await mkdir(remotePath, { recursive: true });
    },
    writeFile: async (remotePath, bytes) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await readFile(remotePath),
    listFiles: async (remotePath) => {
      const entries = await readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    },
    remove: async (remotePath) => {
      await rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
    },
  };
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      let filesTransferred = 0;
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await readFile(mapping.sourcePath);
        await mkdir(path.posix.dirname(mapping.targetPath), { recursive: true });
        await writeFile(mapping.targetPath, bytes);
        filesTransferred += 1;
        bytesTransferred += bytes.byteLength;
      }
      for (const command of operation.postUploadCommands ?? []) {
        await execFile("sh", ["-c", command.command], { maxBuffer: 32 * 1024 * 1024 });
      }
      resultOperations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
    }
    return { operations: resultOperations };
  };
  return client;
}

describe("interrupted managed clone staging", () => {
  const cleanupDirs: string[] = [];
  const snapshots: GitWorkspaceSnapshot[] = [];

  afterEach(async () => {
    for (const snapshot of snapshots.splice(0)) await disposeGitWorkspaceSnapshot(snapshot);
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createWorkspace(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(root);
    const local = path.join(root, "local");
    await createRepo(local, "frontend");
    await createRepo(path.join(local, ".paperclip-repositories/backend"), "backend");
    await writeFile(path.join(local, ".git/info/exclude"), ".paperclip-repositories/\n");
    await mkdir(path.join(local, STAGING_PATH, ".git"), { recursive: true });
    await writeFile(path.join(local, STAGING_PATH, "partial.txt"), "interrupted clone");
    return local;
  }

  it("skips the staging directory when reading nested repositories", async () => {
    const local = await createWorkspace("paperclip-clone-staging-snapshot-");

    const snapshot = await readGitWorkspaceSnapshot(local);
    if (snapshot) snapshots.push(snapshot);

    expect(snapshot?.repositories?.map((entry) => entry.path)).toEqual([".paperclip-repositories/backend"]);
    const paths = [
      ...workspacePaths(snapshot!.overlayPaths),
      ...workspacePaths(snapshot!.deletedPaths),
      ...workspacePaths(snapshot!.ignoredPaths),
    ];
    expect(paths.some((entry) => entry.includes(".clone-"))).toBe(false);
    expect(await listProjectRepositoryStagingPaths(local)).toEqual([STAGING_PATH]);
    expect(await listLocalProjectRepositories(local)).toEqual([".paperclip-repositories/backend"]);
  });

  it("still rejects an unexpected entry in the nested repositories directory", async () => {
    const local = await createWorkspace("paperclip-clone-staging-invalid-");
    await mkdir(path.join(local, ".paperclip-repositories/backend.backup"));

    await expect(readGitWorkspaceSnapshot(local)).rejects.toThrow("Invalid project repository directory");
    await expect(listLocalProjectRepositories(local)).rejects.toThrow("Invalid project repository directory");
  });

  it("neither ships nor deletes the staging directory during a sandbox round trip", async () => {
    const local = await createWorkspace("paperclip-clone-staging-sandbox-");
    const remote = path.join(path.dirname(local), "remote");
    const backend = ".paperclip-repositories/backend";

    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "clone-staging", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      client: makeFilesystemClient(),
      adapterKey: "test",
      workspaceLocalDir: local,
    });

    expect(await readFile(path.join(remote, backend, "README.md"), "utf8")).toBe("backend");
    await expect(stat(path.join(remote, STAGING_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(remote, backend, "README.md"), "updated backend");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, backend, "README.md"), "utf8")).toBe("updated backend");
    expect(await readFile(path.join(local, STAGING_PATH, "partial.txt"), "utf8")).toBe("interrupted clone");
  }, 30_000);
});
