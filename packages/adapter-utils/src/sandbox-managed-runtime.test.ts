import { promises as fsPromises } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalGitIndexToHead } from "./git-workspace-sync.js";

import {
  assertSyncOperationsConfined,
  mirrorDirectory,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeAsset,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "./sandbox-managed-runtime.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import { SYNC_OPERATION_CONCURRENCY_LIMIT } from "./sync-operation-schedule.js";
import {
  createRuntimeSpanRunner,
  getActiveStepContext,
  measureStartupStep,
  type RuntimeSpanRunner,
  type StartupSpan,
  type StartupTraceContext,
  type StartupTracer,
} from "./acpx-engine/startup-timing.js";
import type { RunProcessResult } from "./server-utils.js";

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Give a bare fake client a `syncIn` that reproduces the non-native base64-tar
// FALLBACK (place each file mapping via `writeFile`, then run the operation's
// ordered `postUploadCommands` fail-fast via `run`) — byte-for-byte the prior
// inline `writeFile`+`run` sequence, exercised through the unified seam. Inbound
// staging uses only `kind: "file"` mappings.
function attachFallbackSyncIn(client: SandboxManagedRuntimeClient, timeoutMs = 30_000): void {
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      let filesTransferred = 0;
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await readFile(mapping.sourcePath);
        await client.makeDir(path.posix.dirname(mapping.targetPath));
        if (mapping.mode != null) {
          const staged = `${mapping.targetPath}.pcstage`;
          await client.writeFile(staged, toArrayBuffer(bytes));
          await client.run(
            `chmod ${(mapping.mode & 0o7777).toString(8)} '${staged}' && mv -f '${staged}' '${mapping.targetPath}'`,
            { timeoutMs },
          );
        } else {
          await client.writeFile(mapping.targetPath, toArrayBuffer(bytes));
        }
        filesTransferred += 1;
        bytesTransferred += bytes.byteLength;
      }
      for (const command of operation.postUploadCommands ?? []) {
        await client.run(command.command, { timeoutMs: command.timeoutMs ?? timeoutMs });
      }
      resultOperations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
    }
    return { operations: resultOperations };
  };
}

// A NATIVE-simulating `syncIn`: it records the operations for assertion and
// materializes files directly (never through the client's `writeFile`/`run`), so
// a test can prove the orchestrator delegates entirely to `syncIn` (0 direct
// `writeFile`/`run` execs). Post-upload commands still run in-sandbox (via `sh`),
// modeling a provider that honors `postUploadCommands` after `uploadFiles`.
function attachNativeRecordingSyncIn(
  client: SandboxManagedRuntimeClient,
  captured: SandboxSyncOperation[],
): void {
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      captured.push(operation);
      let filesTransferred = 0;
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await readFile(mapping.sourcePath);
        await mkdir(path.posix.dirname(mapping.targetPath), { recursive: true });
        await writeFile(mapping.targetPath, bytes);
        if (mapping.mode != null) await fsPromises.chmod(mapping.targetPath, mapping.mode);
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
}

// A capturing `syncIn` that records every operation for assertion and
// materializes file AND directory mappings. A directory mapping (a referenced
// project) uses `mirrorDirectory`, so a test can assert the advisory `access`
// intent on directory mappings as well as file mappings.
function attachCapturingSyncIn(
  client: SandboxManagedRuntimeClient,
  captured: SandboxSyncOperation[],
): void {
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      captured.push(operation);
      let filesTransferred = 0;
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        await mkdir(path.posix.dirname(mapping.targetPath), { recursive: true });
        if (mapping.kind === "directory") {
          await mirrorDirectory(mapping.sourcePath, mapping.targetPath);
        } else {
          const bytes = await readFile(mapping.sourcePath);
          await writeFile(mapping.targetPath, bytes);
          if (mapping.mode != null) await fsPromises.chmod(mapping.targetPath, mapping.mode);
          bytesTransferred += bytes.byteLength;
        }
        filesTransferred += 1;
      }
      for (const command of operation.postUploadCommands ?? []) {
        await execFile("sh", ["-c", command.command], { maxBuffer: 32 * 1024 * 1024 });
      }
      resultOperations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
    }
    return { operations: resultOperations };
  };
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      chmod: vi.fn(actual.promises.chmod),
      rename: vi.fn(actual.promises.rename),
    },
  };
});

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

async function listTarMembers(rootDir: string, name: string, bytes: Buffer): Promise<string[]> {
  const tarPath = path.join(rootDir, name);
  await writeFile(tarPath, bytes);
  const { stdout } = await execFile("tar", ["-tf", tarPath], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Build a filesystem-backed managed-runtime client. The host tarball path runs
// unchanged; the client just materializes the mappings on the local disk, so a
// pack-span test needs no provider.
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
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    },
    remove: async (remotePath) => {
      await rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
    },
  };
  attachFallbackSyncIn(client);
  return client;
}

// One recorded span from the fake tracer. `parentName` is the name of the span
// that the start context carried, so a test can assert the parent relationship.
interface RecordedSpan {
  name: string;
  parentName: string | null;
  ended: boolean;
  attributes: Record<string, string | number | boolean>;
}

// A fake trace context that records every span and its parent by name. It
// satisfies the structural `StartupTraceContext` contract, so the real
// `createRuntimeSpanRunner` and `measureStartupStep` drive it unchanged. The
// opaque parent token is the parent's `RecordedSpan`, so a child span reads its
// parent name from the start context.
function createRecordingTraceContext(): {
  traceContext: StartupTraceContext;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const byHandle = new WeakMap<StartupSpan, RecordedSpan>();
  const tracer: StartupTracer = {
    startSpan(name, options, context) {
      const parent = context as RecordedSpan | undefined;
      const record: RecordedSpan = {
        name,
        parentName: parent?.name ?? null,
        ended: false,
        attributes: { ...(options?.attributes ?? {}) },
      };
      spans.push(record);
      const handle: StartupSpan = {
        setAttribute(key, value) {
          record.attributes[key] = value;
        },
        setStatus() {},
        end() {
          record.ended = true;
        },
      };
      byHandle.set(handle, record);
      return handle;
    },
  };
  const traceContext: StartupTraceContext = {
    tracer,
    contextWithSpan: (span) => byHandle.get(span),
  };
  return { traceContext, spans };
}

describe("sandbox managed runtime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves excluded local workspace artifacts during restore mirroring", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-restore-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "target");
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(targetDir, ".claude"), { recursive: true });
    await mkdir(path.join(targetDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(sourceDir, "src", "app.ts"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(targetDir, "stale.txt"), "remove me\n", "utf8");
    await writeFile(path.join(targetDir, ".claude", "settings.json"), "{\"keep\":true}\n", "utf8");
    await writeFile(path.join(targetDir, ".claude.json"), "{\"keep\":true}\n", "utf8");
    await writeFile(path.join(targetDir, ".paperclip-runtime", "state.json"), "{}\n", "utf8");

    await mirrorDirectory(sourceDir, targetDir, {
      preserveAbsent: [".paperclip-runtime", ".claude", ".claude.json"],
    });

    await expect(readFile(path.join(targetDir, "src", "app.ts"), "utf8")).resolves.toBe("export const value = 2;\n");
    await expect(readFile(path.join(targetDir, ".claude", "settings.json"), "utf8")).resolves.toBe("{\"keep\":true}\n");
    await expect(readFile(path.join(targetDir, ".claude.json"), "utf8")).resolves.toBe("{\"keep\":true}\n");
    await expect(readFile(path.join(targetDir, ".paperclip-runtime", "state.json"), "utf8")).resolves.toBe("{}\n");
    await expect(readFile(path.join(targetDir, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies file mode on a staged sibling before renaming into place", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-copy-mode-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "target");
    const relativePath = path.join("nested", "script.sh");
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "#!/bin/sh\necho hello\n", { mode: 0o600 });
    await mkdir(targetDir, { recursive: true });

    const chmodMock = vi.mocked(fsPromises.chmod);
    const renameMock = vi.mocked(fsPromises.rename);
    chmodMock.mockClear();
    renameMock.mockClear();

    await mirrorDirectory(sourceDir, targetDir);

    await expect(readFile(targetPath, "utf8")).resolves.toBe("#!/bin/sh\necho hello\n");
    expect(chmodMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(chmodMock.mock.calls[0]?.[0]).toContain(".paperclip-copy.");
    expect(chmodMock.mock.calls[0]?.[0]).not.toBe(targetPath);
    expect(chmodMock.mock.invocationCallOrder[0]).toBeLessThan(renameMock.mock.invocationCallOrder[0]);
  });

  it("cleans up a staged sibling when chmod fails before rename", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-copy-cleanup-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "target");
    const relativePath = path.join("nested", "script.sh");
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "#!/bin/sh\necho hello\n", { mode: 0o600 });
    await mkdir(targetDir, { recursive: true });

    const chmodMock = vi.mocked(fsPromises.chmod);
    const renameMock = vi.mocked(fsPromises.rename);
    chmodMock.mockClear();
    renameMock.mockClear();
    chmodMock.mockImplementationOnce(async () => {
      throw new Error("chmod failed");
    });

    await expect(mirrorDirectory(sourceDir, targetDir)).rejects.toThrow(/chmod failed/);

    expect(chmodMock).toHaveBeenCalledTimes(1);
    expect(renameMock).not.toHaveBeenCalled();
    const stagedPath = chmodMock.mock.calls[0]?.[0];
    expect(stagedPath).toContain(".paperclip-copy.");
    await expect(readFile(stagedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs workspace and assets through a provider-neutral sandbox client", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-managed-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    const linkedAssetPath = path.join(rootDir, "linked-skill.md");
    await mkdir(path.join(localWorkspaceDir, ".claude"), { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "._README.md"), "appledouble\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, ".claude", "settings.json"), "{\"local\":true}\n", "utf8");
    await writeFile(linkedAssetPath, "skill body\n", "utf8");
    await symlink(linkedAssetPath, path.join(localAssetsDir, "skill.md"));

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
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
      },
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], {
          maxBuffer: 32 * 1024 * 1024,
        });
      },
    };
    const runtimeStatuses: string[] = [];

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      workspaceExclude: [".claude"],
      preserveAbsentOnRestore: [".claude"],
      onRuntimeProgress: async (status) => {
        runtimeStatuses.push(`${status.phase}:${status.message}`);
      },
      assets: [{
        key: "skills",
        localDir: localAssetsDir,
        followSymlinks: true,
      }],
    });

    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("local workspace\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "._README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(remoteWorkspaceDir, ".claude", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(prepared.assetDirs.skills, "skill.md"), "utf8")).resolves.toBe("skill body\n");
    expect((await lstat(path.join(prepared.assetDirs.skills, "skill.md"))).isFile()).toBe(true);

    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "sync back\n", "utf8");
    await mkdir(path.join(localWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "{}\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "local-stale.txt"), "remove\n", "utf8");
    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe("remote workspace\n");
    await expect(readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe("sync back\n");
    await expect(readFile(path.join(localWorkspaceDir, "local-stale.txt"), "utf8")).resolves.toBe("remove\n");
    await expect(readFile(path.join(localWorkspaceDir, ".claude", "settings.json"), "utf8")).resolves.toBe("{\"local\":true}\n");
    await expect(readFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "utf8")).resolves.toBe("{}\n");
    expect(runtimeStatuses).toEqual(expect.arrayContaining([
      "config_sync:Syncing workspace to sandbox",
      "config_sync:Syncing runtime assets to sandbox",
      "restore:Restoring workspace from sandbox",
      "finalize:Finalizing sandbox workspace",
    ]));
    expect(runtimeStatuses).toEqual(expect.arrayContaining([
      expect.stringMatching(/^config_sync:Syncing workspace to sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/),
      expect.stringMatching(/^config_sync:Syncing skills to sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/),
      expect.stringMatching(/^restore:Restoring workspace from sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/),
    ]));
    expect(runtimeStatuses.at(-1)).toBe("finalize:Finalizing sandbox workspace");
  });

  it.each(["workspace", "git-workspace"])(
    "rejects an asset key that collides with the reserved %s archive name",
    async (reservedKey) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-asset-key-"));
      cleanupDirs.push(rootDir);
      const localWorkspaceDir = path.join(rootDir, "local-workspace");
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      const localAssetsDir = path.join(rootDir, "local-assets");
      await mkdir(localWorkspaceDir, { recursive: true });
      await mkdir(localAssetsDir, { recursive: true });
      await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");

      const client = makeFilesystemClient();
      await expect(
        prepareSandboxManagedRuntime({
          spec: {
            transport: "sandbox",
            provider: "test",
            sandboxId: "sandbox-1",
            remoteCwd: remoteWorkspaceDir,
            timeoutMs: 30_000,
            apiKey: null,
          },
          adapterKey: "test-adapter",
          client,
          workspaceLocalDir: localWorkspaceDir,
          assets: [{ key: reservedKey, localDir: localAssetsDir }],
        }),
      ).rejects.toThrow(/collides with a reserved runtime archive name/);

      // The reserved-key guard fails before any workspace or asset archive is
      // built, so nothing lands in the remote workspace directory.
      await expect(readdir(remoteWorkspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["skills/nested", "skills\\nested", "..", "../escape"])(
    "rejects an asset key that is not a simple path segment: %s",
    async (unsafeKey) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-asset-key-"));
      cleanupDirs.push(rootDir);
      const localWorkspaceDir = path.join(rootDir, "local-workspace");
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      const localAssetsDir = path.join(rootDir, "local-assets");
      await mkdir(localWorkspaceDir, { recursive: true });
      await mkdir(localAssetsDir, { recursive: true });
      await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");

      const client = makeFilesystemClient();
      await expect(
        prepareSandboxManagedRuntime({
          spec: {
            transport: "sandbox",
            provider: "test",
            sandboxId: "sandbox-1",
            remoteCwd: remoteWorkspaceDir,
            timeoutMs: 30_000,
            apiKey: null,
          },
          adapterKey: "test-adapter",
          client,
          workspaceLocalDir: localWorkspaceDir,
          assets: [{ key: unsafeKey, localDir: localAssetsDir }],
        }),
      ).rejects.toThrow(/is not a simple path segment/);
    },
  );

  it("syncs git-backed workspaces through a shallow standalone clone and keeps .git out of archives", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-git-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-worktree");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");

    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(sourceRepoDir, "clean.txt"), "from git\n", "utf8");
    await writeFile(path.join(sourceRepoDir, "deleted.txt"), "delete me\n", "utf8");
    await git(sourceRepoDir, ["add", ".gitignore", "tracked.txt", "clean.txt", "deleted.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    expect((await lstat(path.join(localWorkspaceDir, ".git"))).isFile()).toBe(true);
    await mkdir(path.join(localWorkspaceDir, "node_modules"), { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "untracked.txt"), "from local\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "node_modules", "cache.bin"), "do not upload\n", "utf8");
    await rm(path.join(localWorkspaceDir, "deleted.txt"));

    const uploadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const downloadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const driveProgress = async (
      total: number,
      onProgress: ((done: number, total: number | null) => void | Promise<void>) | undefined,
    ) => {
      if (!onProgress) return;
      await onProgress(Math.max(1, Math.floor(total / 2)), total);
      await onProgress(total, total);
    };
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes, options) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        if (remotePath.endsWith("-upload.tar")) uploadedTars.push({ remotePath, bytes: buffer });
        await writeFile(remotePath, buffer);
        await driveProgress(buffer.byteLength, options?.onProgress);
      },
      readFile: async (remotePath, options) => {
        const buffer = await readFile(remotePath);
        if (remotePath.endsWith("workspace-download.tar")) downloadedTars.push({ remotePath, bytes: buffer });
        await driveProgress(buffer.byteLength, options?.onProgress);
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const runtimeStatuses: Array<{ phase: string; message: string }> = [];

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      onRuntimeProgress: async (status) => {
        runtimeStatuses.push({ phase: status.phase, message: status.message });
      },
    });

    expect((await lstat(path.join(remoteWorkspaceDir, ".git"))).isDirectory()).toBe(true);
    await expect(readFile(path.join(remoteWorkspaceDir, ".git", "shallow"), "utf8")).resolves.toContain(
      await git(localWorkspaceDir, ["rev-parse", "HEAD"]),
    );
    expect(await git(remoteWorkspaceDir, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(remoteWorkspaceDir, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(remoteWorkspaceDir, ["status", "--short"])).toContain("?? untracked.txt");
    await expect(readFile(path.join(remoteWorkspaceDir, "deleted.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const gitUpload = uploadedTars.find((entry) => path.posix.basename(entry.remotePath) === "git-workspace-upload.tar");
    const workspaceUpload = uploadedTars.find((entry) => path.posix.basename(entry.remotePath) === "workspace-upload.tar");
    expect(gitUpload).toBeDefined();
    expect(workspaceUpload).toBeDefined();
    const gitMembers = await listTarMembers(rootDir, "git-upload-list.tar", gitUpload!.bytes);
    const workspaceMembers = await listTarMembers(rootDir, "workspace-upload-list.tar", workspaceUpload!.bytes);
    expect(gitMembers.some((entry) => entry === ".git" || entry.startsWith(".git/"))).toBe(true);
    expect(workspaceMembers.some((entry) => entry === ".git" || entry.startsWith(".git/"))).toBe(false);
    expect(workspaceMembers).toContain("tracked.txt");
    expect(workspaceMembers).toContain("untracked.txt");
    expect(workspaceMembers).not.toContain("clean.txt");
    expect(workspaceMembers.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))).toBe(false);

    await git(remoteWorkspaceDir, ["config", "user.name", "Paperclip Sandbox"]);
    await git(remoteWorkspaceDir, ["config", "user.email", "sandbox@paperclip.dev"]);
    await git(remoteWorkspaceDir, ["add", "-A"]);
    await git(remoteWorkspaceDir, ["commit", "-m", "sandbox update"]);
    await writeFile(path.join(remoteWorkspaceDir, "tracked.txt"), "remote dirty\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "from sandbox\n", "utf8");

    await prepared.restoreWorkspace();

    expect((await lstat(path.join(localWorkspaceDir, ".git"))).isFile()).toBe(true);
    expect(await git(localWorkspaceDir, ["log", "-1", "--pretty=%s"])).toBe("sandbox update");
    await expect(readFile(path.join(localWorkspaceDir, "tracked.txt"), "utf8")).resolves.toBe("remote dirty\n");
    await expect(readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe("from sandbox\n");
    await expect(readFile(path.join(localWorkspaceDir, "deleted.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(localWorkspaceDir, "node_modules", "cache.bin"), "utf8")).resolves.toBe("do not upload\n");

    expect(downloadedTars).toHaveLength(1);
    const downloadMembers = await listTarMembers(rootDir, "workspace-download-list.tar", downloadedTars[0]!.bytes);
    expect(downloadMembers.some((entry) => entry === ".git" || entry.startsWith(".git/"))).toBe(false);
    expect(downloadMembers.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))).toBe(false);
    expect(runtimeStatuses.map((status) => status.phase)).toEqual(expect.arrayContaining([
      "git_sync",
      "config_sync",
      "export",
      "restore",
      "finalize",
    ]));
    // Git history and workspace overlay sync as ONE merged operation, so a single
    // transfer-progress event rides the config_sync (workspace) phase. The git_sync
    // phase still emits its plain status message (asserted by the arrayContaining
    // check above).
    expect(runtimeStatuses.some((status) => (
      status.phase === "config_sync" &&
      /^Syncing workspace to sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/.test(status.message)
    ))).toBe(true);
    expect(runtimeStatuses.some((status) => (
      status.phase === "export" &&
      /^Exporting git history from sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/.test(status.message)
    ))).toBe(true);
  });

  it("repairs stale host index deletions when the sandbox restores a clean git worktree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-clean-restore-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-worktree");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");

    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "kept.txt"), "kept\n", "utf8");
    await writeFile(path.join(sourceRepoDir, "restored.txt"), "restored\n", "utf8");
    await git(sourceRepoDir, ["add", "kept.txt", "restored.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    await git(localWorkspaceDir, ["rm", "restored.txt"]);
    expect(await git(localWorkspaceDir, ["status", "--short"])).toContain("D  restored.txt");

    const missingStatusReads: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => {
        if (remotePath.endsWith("workspace-status.txt")) {
          missingStatusReads.push(remotePath);
          throw new Error("status file unavailable");
        }
        return await readFile(remotePath);
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    expect(await git(remoteWorkspaceDir, ["status", "--short"])).toContain("D restored.txt");
    await git(remoteWorkspaceDir, ["reset", "--hard", "HEAD"]);
    expect(await git(remoteWorkspaceDir, ["status", "--short"])).toBe("");

    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localWorkspaceDir, "restored.txt"), "utf8")).resolves.toBe("restored\n");
    expect(await git(localWorkspaceDir, ["ls-files", "restored.txt"])).toBe("restored.txt");
    expect(await git(localWorkspaceDir, ["status", "--short"])).toBe("");
    expect(await git(localWorkspaceDir, ["diff", "--name-status", "HEAD", "--"])).toBe("");
    expect(await git(localWorkspaceDir, ["diff", "--cached", "--name-status", "HEAD", "--"])).toBe("");
    expect(missingStatusReads).toHaveLength(1);
  });

  it("does not fail clean restore checks when local working tree changes survive", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-preserved-local-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-worktree");

    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "kept.txt"), "base\n", "utf8");
    await git(sourceRepoDir, ["add", "kept.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    await writeFile(path.join(localWorkspaceDir, "kept.txt"), "local user change\n", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await resetLocalGitIndexToHead({
        localDir: localWorkspaceDir,
        checkWorkingTreeClean: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[paperclip] Workspace restore preserved local working tree changes after clean sandbox restore.",
      );
    } finally {
      warnSpy.mockRestore();
    }

    await expect(readFile(path.join(localWorkspaceDir, "kept.txt"), "utf8")).resolves.toBe("local user change\n");
    expect(await git(localWorkspaceDir, ["diff", "--cached", "--name-status", "HEAD", "--"])).toBe("");
    expect(await git(localWorkspaceDir, ["status", "--short"])).toContain("M kept.txt");
  });

  it("excludes unignored dependency trees from git-backed workspace overlay archives", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-unignored-deps-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-worktree");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");

    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await mkdir(path.join(sourceRepoDir, "src"), { recursive: true });
    await writeFile(path.join(sourceRepoDir, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");
    await git(sourceRepoDir, ["add", "src/tracked.ts"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    await mkdir(path.join(localWorkspaceDir, "node_modules", "root-package"), { recursive: true });
    await mkdir(path.join(localWorkspaceDir, "packages", "ui", "node_modules", "nested-package"), { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "node_modules", "root-package", "cache.bin"), "root dependency\n", "utf8");
    await writeFile(
      path.join(localWorkspaceDir, "packages", "ui", "node_modules", "nested-package", "cache.bin"),
      "nested dependency\n",
      "utf8",
    );
    await writeFile(path.join(localWorkspaceDir, "src", "local-only.ts"), "export const local = true;\n", "utf8");

    const uploadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const downloadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        if (remotePath.endsWith("-upload.tar")) uploadedTars.push({ remotePath, bytes: buffer });
        await writeFile(remotePath, buffer);
      },
      readFile: async (remotePath) => {
        const buffer = await readFile(remotePath);
        if (remotePath.endsWith("workspace-download.tar")) downloadedTars.push({ remotePath, bytes: buffer });
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    const workspaceUpload = uploadedTars.find((entry) => path.posix.basename(entry.remotePath) === "workspace-upload.tar");
    expect(workspaceUpload).toBeDefined();
    const workspaceMembers = await listTarMembers(rootDir, "unignored-deps-workspace-upload.tar", workspaceUpload!.bytes);
    expect(workspaceMembers).toContain("src/local-only.ts");
    expect(workspaceMembers.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))).toBe(false);
    expect(workspaceMembers.some((entry) => entry.includes("/node_modules/") || entry.endsWith("/node_modules"))).toBe(false);

    await expect(readFile(path.join(remoteWorkspaceDir, "src", "local-only.ts"), "utf8")).resolves.toBe("export const local = true;\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "node_modules", "root-package", "cache.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(remoteWorkspaceDir, "packages", "ui", "node_modules", "nested-package", "cache.bin"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(path.join(remoteWorkspaceDir, "node_modules", "sandbox-package"), { recursive: true });
    await mkdir(path.join(remoteWorkspaceDir, "packages", "ui", "node_modules", "sandbox-package"), { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, "node_modules", "sandbox-package", "cache.bin"), "sandbox root dependency\n", "utf8");
    await writeFile(
      path.join(remoteWorkspaceDir, "packages", "ui", "node_modules", "sandbox-package", "cache.bin"),
      "sandbox nested dependency\n",
      "utf8",
    );
    await writeFile(path.join(remoteWorkspaceDir, "src", "remote-only.ts"), "export const remote = true;\n", "utf8");

    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localWorkspaceDir, "node_modules", "root-package", "cache.bin"), "utf8")).resolves.toBe("root dependency\n");
    await expect(
      readFile(path.join(localWorkspaceDir, "packages", "ui", "node_modules", "nested-package", "cache.bin"), "utf8"),
    ).resolves.toBe("nested dependency\n");
    await expect(readFile(path.join(localWorkspaceDir, "src", "remote-only.ts"), "utf8")).resolves.toBe("export const remote = true;\n");
    await expect(readFile(path.join(localWorkspaceDir, "node_modules", "sandbox-package", "cache.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(downloadedTars).toHaveLength(1);
    const downloadMembers = await listTarMembers(rootDir, "unignored-deps-workspace-download.tar", downloadedTars[0]!.bytes);
    expect(downloadMembers.some((entry) => entry === ".git" || entry.startsWith(".git/"))).toBe(false);
    expect(downloadMembers.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))).toBe(false);
    expect(downloadMembers.some((entry) => entry.includes("/node_modules/") || entry.endsWith("/node_modules"))).toBe(false);
  });

  it("builds workspace/asset tarballs without a './' self-entry (so untar does not chmod/utime an unowned target dir)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-tarself-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(path.join(localWorkspaceDir, "src"), { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "ws\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, "src", "main.ts"), "x\n", "utf8");
    await writeFile(path.join(localAssetsDir, "asset.txt"), "a\n", "utf8");

    // Capture every tar uploaded/downloaded through the sandbox so we can inspect its members.
    const uploadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const downloadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        if (remotePath.endsWith("-upload.tar")) uploadedTars.push({ remotePath, bytes: buffer });
        await writeFile(remotePath, buffer);
      },
      readFile: async (remotePath) => {
        const buffer = await readFile(remotePath);
        if (remotePath.endsWith("workspace-download.tar")) downloadedTars.push({ remotePath, bytes: buffer });
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "skills", localDir: localAssetsDir }],
    });

    expect(uploadedTars.length).toBeGreaterThanOrEqual(2);
    for (const { remotePath, bytes } of uploadedTars) {
      const listPath = path.join(rootDir, `list-${path.basename(remotePath)}`);
      await writeFile(listPath, bytes);
      const { stdout } = await execFile("tar", ["-tf", listPath], { maxBuffer: 32 * 1024 * 1024 });
      const members = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      // The archive must NOT contain a self-entry for the root directory; that is
      // what makes tar try to mutate the (possibly unowned) extraction target.
      expect(members).not.toContain(".");
      expect(members).not.toContain("./");
    }

    // And the workspace still extracts correctly into an existing target dir.
    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("ws\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "src", "main.ts"), "utf8")).resolves.toBe("x\n");

    await prepared.restoreWorkspace();
    expect(downloadedTars).toHaveLength(1);
    const downloadMembers = await listTarMembers(rootDir, "workspace-download-list.tar", downloadedTars[0]!.bytes);
    expect(downloadMembers).not.toContain(".");
    expect(downloadMembers).not.toContain("./");
  });

  it("excludes transient symlinked home dirs from the asset tar while keeping required content", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-home-tmp-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    await mkdir(localWorkspaceDir, { recursive: true });

    // Simulate a host Codex binary that a stale `tmp/arg0` symlink points at.
    // With followSymlinks the archive would otherwise inline this whole file.
    const hostBinary = path.join(rootDir, "codex-host-binary");
    const binaryMarker = "HOST_CODEX_BINARY_BYTES";
    await writeFile(hostBinary, `${binaryMarker}\n`.repeat(4096), "utf8");

    // Required managed-home content that MUST still reach the sandbox.
    await mkdir(path.join(homeDir, "skills"), { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), "{\"OPENAI_API_KEY\":\"sk-test\"}\n", "utf8");
    await writeFile(path.join(homeDir, "config.toml"), "model = \"gpt\"\n", "utf8");
    await writeFile(path.join(homeDir, "skills", "demo.md"), "skill body\n", "utf8");

    // Transient dirs holding symlinks to the host binary (the bloat source).
    await mkdir(path.join(homeDir, "tmp", "arg0"), { recursive: true });
    await mkdir(path.join(homeDir, ".tmp"), { recursive: true });
    await symlink(hostBinary, path.join(homeDir, "tmp", "arg0", "codex"));
    await symlink(hostBinary, path.join(homeDir, ".tmp", "codex"));

    const uploadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        if (remotePath.endsWith("-upload.tar")) uploadedTars.push({ remotePath, bytes: buffer });
        await writeFile(remotePath, buffer);
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "codex",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "home",
        localDir: homeDir,
        followSymlinks: true,
        exclude: ["tmp", ".tmp"],
      }],
    });

    const homeTar = uploadedTars.find(({ remotePath }) => path.basename(remotePath) === "home-upload.tar");
    expect(homeTar).toBeDefined();
    const members = await listTarMembers(rootDir, "home-members.tar", homeTar!.bytes);

    // Transient symlink trees must be filtered out entirely.
    expect(members.some((entry) => entry === "tmp" || entry.startsWith("tmp/"))).toBe(false);
    expect(members.some((entry) => entry === ".tmp" || entry.startsWith(".tmp/"))).toBe(false);
    // Required managed-home content must survive.
    expect(members).toContain("auth.json");
    expect(members).toContain("config.toml");
    expect(members.some((entry) => entry === "skills/demo.md")).toBe(true);

    // The host binary bytes must not have been inlined into the upload.
    expect(homeTar!.bytes.includes(Buffer.from(binaryMarker))).toBe(false);

    // The extracted sandbox home keeps required content and omits the transient dirs.
    await expect(readFile(path.join(prepared.assetDirs.home, "auth.json"), "utf8"))
      .resolves.toBe("{\"OPENAI_API_KEY\":\"sk-test\"}\n");
    await expect(readFile(path.join(prepared.assetDirs.home, "skills", "demo.md"), "utf8"))
      .resolves.toBe("skill body\n");
    await expect(lstat(path.join(prepared.assetDirs.home, "tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(prepared.assetDirs.home, ".tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits throttled, labeled upload and restore progress with direction and percentages", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-progress-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "skill.md"), "skill\n", "utf8");

    // Drive byte progress in 100 fine (1%) increments so the throttle has many
    // chances to emit; the reporter must collapse them to ~one line per 10% step.
    const driveProgress = async (
      total: number,
      onProgress: ((done: number, total: number | null) => void | Promise<void>) | undefined,
    ) => {
      if (!onProgress) return;
      for (let i = 1; i <= 100; i++) {
        await onProgress(Math.floor((total * i) / 100), total);
      }
    };

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes, options) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        const buffer = Buffer.from(bytes);
        await writeFile(remotePath, buffer);
        await driveProgress(buffer.byteLength, options?.onProgress);
      },
      readFile: async (remotePath, options) => {
        const buffer = await readFile(remotePath);
        await driveProgress(buffer.byteLength, options?.onProgress);
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    const lines: string[] = [];
    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "skills", localDir: localAssetsDir }],
      onProgress: (line) => {
        lines.push(line);
      },
    });

    const uploadWorkspaceLines = lines.filter((line) => line.includes("Syncing workspace to sandbox"));
    const uploadAssetLines = lines.filter((line) => line.includes("Syncing skills to sandbox"));
    expect(uploadWorkspaceLines.length).toBeGreaterThan(0);
    expect(uploadAssetLines.length).toBeGreaterThan(0);
    // 100 reported increments must be throttled to at most ~one line per 10% step.
    expect(uploadWorkspaceLines.length).toBeLessThanOrEqual(11);
    // Reaches 100% and shows the MB breakdown.
    expect(uploadWorkspaceLines.some((line) => line.includes("100%"))).toBe(true);
    expect(uploadWorkspaceLines.every((line) => /\(\d+\.\d\/\d+\.\d MB\)/.test(line))).toBe(true);

    await prepared.restoreWorkspace();
    const restoreLines = lines.filter((line) => line.includes("Restoring workspace from sandbox"));
    expect(restoreLines.length).toBeGreaterThan(0);
    expect(restoreLines.length).toBeLessThanOrEqual(11);
    expect(restoreLines.some((line) => line.includes("100%"))).toBe(true);
  });

  it("creates valid empty workspace tarballs when the workspace is empty", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-empty-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });

    const downloadedTars: { remotePath: string; bytes: Buffer }[] = [];
    const runCommands: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => {
        const buffer = await readFile(remotePath);
        if (remotePath.endsWith("workspace-download.tar")) downloadedTars.push({ remotePath, bytes: buffer });
        return buffer;
      },
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        runCommands.push(command);
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    await prepared.restoreWorkspace();
    expect(downloadedTars).toHaveLength(1);
    const members = await listTarMembers(rootDir, "empty-workspace-download.tar", downloadedTars[0]!.bytes);
    expect(members).toEqual([]);
    const emptyArchiveCommand = runCommands.find((command) => command.includes("dd if=/dev/zero"));
    expect(emptyArchiveCommand).toBeDefined();
    expect(emptyArchiveCommand).not.toContain("/dev/null");
  });

  it("provisions a contribution-less asset via a plain tar extract and restores it as a no-op", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-default-asset-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "plain.txt"), "plain asset\n", "utf8");

    const stagedWrites: string[] = [];
    const runCommands: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        if (!remotePath.endsWith("-upload.tar")) stagedWrites.push(path.basename(remotePath));
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        runCommands.push(command);
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      // No `provision` / `restore` on the asset: it must ride the default path.
      assets: [{ key: "plain", localDir: localAssetsDir }],
    });

    // Extracted through the default `tar -xf` path.
    await expect(readFile(path.join(prepared.assetDirs.plain, "plain.txt"), "utf8")).resolves.toBe("plain asset\n");
    // A contribution-less asset stages no extra files beyond its own tar.
    expect(stagedWrites.filter((name) => name.includes("plain"))).toEqual([]);
    // The extract command is the generic tar path, not an adapter-specific script.
    const assetExtract = runCommands.find((command) => command.includes(`${path.posix.basename(prepared.assetDirs.plain)}-upload.tar`));
    expect(assetExtract).toBeDefined();
    expect(assetExtract).toContain("tar -xf");
    expect(assetExtract).not.toMatch(/\.sh|\.cjs/);

    // Restore is a clean no-op for a contribution-less asset (no throw, asset dir untouched).
    await expect(prepared.restoreWorkspace()).resolves.toBeUndefined();
    await expect(readFile(path.join(prepared.assetDirs.plain, "plain.txt"), "utf8")).resolves.toBe("plain asset\n");
  });

  it("round-trips a non-codex asset through generic provision + restore contributions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-seam-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "seed.txt"), "seed\n", "utf8");

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };

    // A minimal shell quoter local to the test's custom extract command; the seam
    // itself carries no adapter knowledge — the fake asset supplies everything.
    const q = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
    const restored: string[] = [];
    const stagedContentSeen: string[] = [];

    attachFallbackSyncIn(client);
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "generic-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "widget",
        localDir: localAssetsDir,
        provision: {
          stageFiles: [{ name: "widget-helper.txt", contents: "helper-bytes\n" }],
          // Extract the asset AND consume the staged helper file, proving both
          // stageFiles and postUploadCommand flow through the core generically.
          postUploadCommand: ({ assetTarPath, assetDir, runtimeRootDir }) =>
            `rm -rf ${q(assetDir)} && mkdir -p ${q(assetDir)} && ` +
            `tar -xf ${q(assetTarPath)} -C ${q(assetDir)} && rm -f ${q(assetTarPath)} && ` +
            `cp ${q(path.posix.join(runtimeRootDir, "widget-helper.txt"))} ${q(path.posix.join(assetDir, "helper.copied.txt"))}`,
        },
        restore: async ({ assetDir, readFile: readRemote }) => {
          const bytes = await readRemote(path.posix.join(assetDir, "refreshed.txt"));
          restored.push(bytes.toString("utf8"));
        },
      }],
    });

    // provision: the asset's own content extracted...
    await expect(readFile(path.join(prepared.assetDirs.widget, "seed.txt"), "utf8")).resolves.toBe("seed\n");
    // ...the staged helper file was written to the runtime root and consumed by the custom extract command.
    await expect(readFile(path.join(prepared.assetDirs.widget, "helper.copied.txt"), "utf8")).resolves.toBe("helper-bytes\n");
    stagedContentSeen.push("provisioned");

    // Simulate the sandbox refreshing a file inside the asset dir, then restore.
    await writeFile(path.join(prepared.assetDirs.widget, "refreshed.txt"), "refreshed-by-sandbox\n", "utf8");
    await prepared.restoreWorkspace();

    // restore contribution was invoked with a working remote readFile against assetDir.
    expect(restored).toEqual(["refreshed-by-sandbox\n"]);
    expect(stagedContentSeen).toEqual(["provisioned"]);
  });

  it("rejects a provision stageFile.name that is not a simple basename", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-traversal-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "seed.txt"), "seed\n", "utf8");

    const writtenPaths: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        writtenPaths.push(remotePath);
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    attachFallbackSyncIn(client);

    // A compromised adapter supplying a traversal name must be rejected before
    // the core ever writes outside the runtime root.
    for (const maliciousName of ["../evil.txt", "..", "nested/child.txt", "back\\slash.txt", "../../etc/passwd"]) {
      writtenPaths.length = 0;
      await expect(
        prepareSandboxManagedRuntime({
          spec: {
            transport: "sandbox",
            provider: "test",
            sandboxId: "sandbox-1",
            remoteCwd: remoteWorkspaceDir,
            timeoutMs: 30_000,
            apiKey: null,
          },
          adapterKey: "generic-adapter",
          client,
          workspaceLocalDir: localWorkspaceDir,
          assets: [{
            key: "widget",
            localDir: localAssetsDir,
            provision: {
              stageFiles: [{ name: maliciousName, contents: "payload\n" }],
            },
          }],
        }),
      ).rejects.toThrow(/must be a simple basename/);

      // The guard fires before the offending write, so nothing landed under the runtime root.
      expect(writtenPaths.some((p) => p.endsWith("evil.txt") || p.endsWith("passwd") || p.endsWith("child.txt"))).toBe(false);
    }
  });

  it("routes a custom-provisioned asset through a single syncIn operation with its post-upload command (native runner → 0 direct writeFile/run)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-native-asset-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localAssetsDir = path.join(rootDir, "local-assets");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localAssetsDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localAssetsDir, "seed.txt"), "seed\n", "utf8");

    // A native runner delegates every staging step to `syncIn`; the orchestrator
    // must make NO direct `writeFile`/`run` exec. These record any leak.
    const directWrites: string[] = [];
    const directRuns: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        directWrites.push(remotePath);
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        directRuns.push(command);
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);

    const q = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "generic-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "widget",
        localDir: localAssetsDir,
        provision: {
          stageFiles: [{ name: "widget-helper.sh", contents: "#!/bin/sh\ntar -xf \"$2\" -C \"$1\"\n" }],
          // A bespoke post-upload command that consumes the staged helper — proves
          // the custom command (not a plain default `tar -xf`) rides syncIn.
          postUploadCommand: ({ assetTarPath, assetDir, runtimeRootDir }) =>
            `rm -rf ${q(assetDir)} && mkdir -p ${q(assetDir)} && ` +
            `sh ${q(path.posix.join(runtimeRootDir, "widget-helper.sh"))} ${q(assetDir)} ${q(assetTarPath)} && ` +
            `rm -f ${q(assetTarPath)}`,
        },
      }],
    });

    // The orchestrator delegated everything to syncIn: no direct exec/writeFile.
    expect(directWrites).toEqual([]);
    expect(directRuns).toEqual([]);

    // Exactly one operation carries the asset: the asset tar + the staged helper
    // as `files`, and the bespoke command as the ordered post-upload command.
    const assetOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("widget-upload.tar")),
    );
    expect(assetOp).toBeDefined();
    const targets = assetOp!.files.map((mapping) => path.posix.basename(mapping.targetPath)).sort();
    expect(targets).toEqual(["widget-helper.sh", "widget-upload.tar"]);
    expect(assetOp!.files.every((mapping) => mapping.kind === "file")).toBe(true);
    expect(assetOp!.postUploadCommands).toHaveLength(1);
    expect(assetOp!.postUploadCommands![0].command).toContain("widget-helper.sh");
    expect(assetOp!.postUploadCommands![0].command).not.toBe(
      `rm -rf ${q(path.posix.join(prepared.runtimeRootDir, "widget"))} && mkdir -p ${q(path.posix.join(prepared.runtimeRootDir, "widget"))}`,
    );

    // The asset tar carries the asset directory as its read-write destination,
    // because the extract command fills that directory, not the staging archive.
    const assetTarMapping = assetOp!.files.find((mapping) => mapping.targetPath.endsWith("widget-upload.tar"));
    expect(assetTarMapping?.access).toBe("rw");
    expect(assetTarMapping?.writablePath).toBe(prepared.assetDirs.widget);

    // The staged helper file is a read-only input that the command consumes, so
    // it is `access: "ro"` and never joins the writable set.
    const stageMapping = assetOp!.files.find((mapping) => mapping.targetPath.endsWith("widget-helper.sh"));
    expect(stageMapping?.access).toBe("ro");
    expect(stageMapping?.writablePath).toBeUndefined();

    // The asset actually materialized through the native seam.
    await expect(readFile(path.join(prepared.assetDirs.widget, "seed.txt"), "utf8")).resolves.toBe("seed\n");
  });

  it("stages git and workspace via syncIn preserving .paperclip-runtime (native runner → 0 direct writeFile/run)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-native-git-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);
    // Pre-seed the sandbox with a `.paperclip-runtime` dir that MUST survive.
    await mkdir(path.join(remoteWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "keep.txt"), "keep\n", "utf8");

    const directWrites: string[] = [];
    const directRuns: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        directWrites.push(remotePath);
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        directRuns.push(command);
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);

    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    // Delegated entirely to syncIn.
    expect(directWrites).toEqual([]);
    expect(directRuns).toEqual([]);

    // One merged operation carries BOTH the git-history and workspace-overlay tars
    // as two `file` mappings, each with its extract as an ordered post-command.
    expect(captured).toHaveLength(1);
    const op = captured[0];
    const byBase = (base: string) =>
      op.files.find((mapping) => path.posix.basename(mapping.targetPath) === base);
    expect(byBase("git-workspace-upload.tar")).toBeDefined();
    expect(byBase("workspace-upload.tar")).toBeDefined();
    expect(op.files.every((mapping) => mapping.kind === "file")).toBe(true);
    // The first post-upload command extracts the git history and preserves
    // `.paperclip-runtime` while replacing the rest of the tree (wipe-except-preserved).
    const gitCommand = op.postUploadCommands![0].command;
    expect(gitCommand).toContain(".paperclip-runtime");
    expect(gitCommand).toContain("tar -xf");

    // The pre-seeded runtime dir survived the git+workspace staging.
    await expect(
      readFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "keep.txt"), "utf8"),
    ).resolves.toBe("keep\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "tracked.txt"), "utf8")).resolves.toBe("tracked\n");
    expect(prepared.workspaceRemoteDir).toBe(remoteWorkspaceDir);
  });

  it("the workspace wipe command preserves in-flight sync scratch tarballs (.paperclip-upload-*)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-scratch-shape-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    // The wipe `find` runs before the extract. It must preserve the daytona
    // scratch prefix so a concurrent referenced-project upload survives the wipe.
    const wipeCommand = captured[0].postUploadCommands![0].command;
    expect(wipeCommand).toContain("find ");
    expect(wipeCommand).toContain("! -name '.paperclip-upload-*'");
  });

  it("the workspace wipe keeps an in-flight scratch tarball at the root but removes a stale sibling", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-scratch-race-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);
    // Pre-seed the sandbox root. `.paperclip-upload-test.tar` simulates a
    // concurrent referenced-project scratch tarball in flight; `stale-junk.txt`
    // is an unrelated child that the wipe must remove.
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, ".paperclip-upload-test.tar"), "scratch\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "stale-junk.txt"), "junk\n", "utf8");

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    // The real `find` wipe ran through `sh -c`. The scratch tarball survived and
    // the unrelated sibling did not.
    await expect(
      readFile(path.join(remoteWorkspaceDir, ".paperclip-upload-test.tar"), "utf8"),
    ).resolves.toBe("scratch\n");
    await expect(
      readFile(path.join(remoteWorkspaceDir, "stale-junk.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("issues one merged syncIn operation for a git-backed workspace stage-sync with two ordered extract commands", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-merged-git-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);
    // Pre-seed the sandbox with a `.paperclip-runtime` dir that MUST survive.
    await mkdir(path.join(remoteWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "keep.txt"), "keep\n", "utf8");

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);
    // Count how many times `syncIn` is invoked so the merge collapses the two
    // workspace staging steps into a single native round trip.
    let syncInCallCount = 0;
    const recordingSyncIn = client.syncIn!;
    client.syncIn = async (operations) => {
      syncInCallCount += 1;
      return recordingSyncIn(operations);
    };

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    // One `syncIn` call carrying exactly one operation for the whole workspace.
    expect(syncInCallCount).toBe(1);
    expect(captured).toHaveLength(1);
    const op = captured[0];

    // Both host tars ride the one operation as two `file` mappings.
    const byBase = (base: string) =>
      op.files.find((mapping) => path.posix.basename(mapping.targetPath) === base);
    const gitMapping = byBase("git-workspace-upload.tar");
    const overlayMapping = byBase("workspace-upload.tar");
    expect(gitMapping).toBeDefined();
    expect(overlayMapping).toBeDefined();
    expect(op.files).toHaveLength(2);
    expect(op.files.every((mapping) => mapping.kind === "file")).toBe(true);

    // Both tar targets live under `.paperclip-runtime`, so the git extract's wipe
    // (which preserves `.paperclip-runtime`) cannot delete the overlay tar before
    // the overlay extract runs.
    for (const mapping of op.files) {
      expect(mapping.targetPath).toContain("/.paperclip-runtime/");
    }

    // Two ordered extract commands: git history first (wipe-except-preserved),
    // overlay second (merge, no wipe). No deleted paths in this clean worktree.
    const commands = op.postUploadCommands ?? [];
    expect(commands).toHaveLength(2);
    expect(commands[0].command).toContain("git-workspace-upload.tar");
    expect(commands[0].command).toContain(".paperclip-runtime");
    expect(commands[0].command).toContain("find ");
    expect(commands[1].command).toContain("workspace-upload.tar");
    expect(commands[1].command).not.toContain("git-workspace-upload.tar");
    expect(commands[1].command).not.toContain("find ");

    // The pre-seeded runtime dir survived and the workspace overlay applied.
    await expect(
      readFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "keep.txt"), "utf8"),
    ).resolves.toBe("keep\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "tracked.txt"), "utf8")).resolves.toBe("tracked\n");
  });

  it("the merged workspace confine guard covers both tar mappings (escape in either trips it)", () => {
    const runtimeRoot = "/home/daytona/paperclip-workspace/.paperclip-runtime/test-adapter";
    const tempRoot = "/tmp/paperclip-sandbox-sync-abc";
    const gitMapping = {
      sourcePath: `${tempRoot}/git-workspace.tar`,
      targetPath: `${runtimeRoot}/git-workspace-upload.tar`,
      kind: "file" as const,
    };
    const overlayMapping = {
      sourcePath: `${tempRoot}/workspace.tar`,
      targetPath: `${runtimeRoot}/workspace-upload.tar`,
      kind: "file" as const,
    };
    const roots = { sourceRoots: [tempRoot], targetRoots: [runtimeRoot] };

    // A confined merged operation with both tar mappings passes the guard.
    expect(() =>
      assertSyncOperationsConfined(
        [{ operationId: "merged", files: [gitMapping, overlayMapping] }],
        roots,
      ),
    ).not.toThrow();

    // A `..` target escape in the overlay mapping trips the guard, so the whole
    // merged operation is rejected before any transfer.
    expect(() =>
      assertSyncOperationsConfined(
        [{
          operationId: "merged",
          files: [
            gitMapping,
            { ...overlayMapping, targetPath: `${runtimeRoot}/../../etc/workspace-upload.tar` },
          ],
        }],
        roots,
      ),
    ).toThrow(/escapes its confinement root|not a confined absolute path/);

    // An absolute-path source escape in the git mapping trips the guard too.
    expect(() =>
      assertSyncOperationsConfined(
        [{
          operationId: "merged",
          files: [{ ...gitMapping, sourcePath: "/etc/passwd" }, overlayMapping],
        }],
        roots,
      ),
    ).toThrow(/escapes its confinement root|not a confined absolute path/);
  });

  // Regression lock: a representative `codex_local` start stages its inbound bytes
  // as TWO `syncIn` operations. The git-history and workspace-overlay tars share
  // ONE merged operation (one native `uploadFiles` round-trip that carries both
  // tars, with the two extract commands as ordered `postUploadCommands`); the
  // managed Codex `home` asset (auth.json merge) is the second operation. Every
  // inbound step is routed through `client.syncIn`, with no separate
  // custom-provision diversion. Assert the collapsed round-trip count so a future
  // change that re-inlines a `writeFile`+`run` sequence — or splits the merged
  // workspace operation back into two — fails loudly here instead of silently
  // regressing the start path.
  it("collapses a representative codex_local start to two syncIn round-trips: one merged workspace op plus the asset op", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-codex-roundtrip-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");

    // Git-backed workspace → git history + workspace overlay share one merged op.
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    // Managed Codex home with an auth.json that a custom post-upload command
    // merges in-sandbox — the credential path is routed onto native uploadFiles.
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), "{\"OPENAI_API_KEY\":\"sk-test\"}\n", "utf8");
    await writeFile(path.join(homeDir, "config.toml"), "model = \"gpt\"\n", "utf8");

    // A native runner delegates every staging step to `syncIn`; ANY direct
    // writeFile/run exec is a collapse regression.
    const directWrites: string[] = [];
    const directRuns: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        directWrites.push(remotePath);
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        directRuns.push(command);
        await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
      },
    };
    const captured: SandboxSyncOperation[] = [];
    attachNativeRecordingSyncIn(client, captured);

    const q = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "codex",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "home",
        localDir: homeDir,
        provision: {
          stageFiles: [{ name: "home-merge.sh", contents: "#!/bin/sh\ntar -xf \"$2\" -C \"$1\"\n" }],
          postUploadCommand: ({ assetTarPath, assetDir, runtimeRootDir }) =>
            `mkdir -p ${q(assetDir)} && ` +
            `sh ${q(path.posix.join(runtimeRootDir, "home-merge.sh"))} ${q(assetDir)} ${q(assetTarPath)} && ` +
            `rm -f ${q(assetTarPath)}`,
        },
      }],
    });

    // The orchestrator delegated everything to syncIn: no re-inlined writeFile/run.
    expect(directWrites).toEqual([]);
    expect(directRuns).toEqual([]);

    // The collapsed count: exactly two inbound round-trips — the merged workspace
    // op (git history + overlay) and the home asset op.
    expect(captured).toHaveLength(2);
    const hasBase = (op: SandboxSyncOperation, base: string) =>
      op.files.some((mapping) => path.posix.basename(mapping.targetPath) === base);
    const workspaceOp = captured.find((op) => hasBase(op, "workspace-upload.tar"));
    const homeOp = captured.find((op) => hasBase(op, "home-upload.tar"));
    expect(workspaceOp).toBeDefined();
    expect(homeOp).toBeDefined();
    // The merged workspace op carries BOTH the git-history and overlay tars, with
    // both extract commands as ordered post-upload commands (git first, overlay
    // second). The two tars ride one native uploadFiles round-trip.
    expect(hasBase(workspaceOp!, "git-workspace-upload.tar")).toBe(true);
    expect(workspaceOp!.files).toHaveLength(2);
    expect((workspaceOp!.postUploadCommands ?? []).length).toBeGreaterThanOrEqual(2);

    // Every operation is a native uploadFiles (all `file` mappings) whose
    // extract/merge rides as an ordered provider-executed post-upload command.
    for (const op of captured) {
      expect(op.files.length).toBeGreaterThanOrEqual(1);
      expect(op.files.every((mapping) => mapping.kind === "file")).toBe(true);
      expect(op.postUploadCommands ?? []).not.toHaveLength(0);
    }
    // Operation ids are distinct, so "2 operations" is 2 real round-trips.
    expect(new Set(captured.map((op) => op.operationId)).size).toBe(2);

    // The credential asset actually materialized through the native seam.
    await expect(readFile(path.join(prepared.assetDirs.home, "auth.json"), "utf8"))
      .resolves.toBe("{\"OPENAI_API_KEY\":\"sk-test\"}\n");
  });

  it("authors the advisory access intent rw on workspace, git, and asset inbound mappings", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-access-rw-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetDir = path.join(rootDir, "asset-home");

    // A git-backed workspace produces both a git-history tar and an overlay tar.
    await mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(sourceRepoDir, "tracked.txt"), "tracked\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);

    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(assetDir, "config.toml"), "model = \"gpt\"\n", "utf8");

    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => { await mkdir(remotePath, { recursive: true }); },
      writeFile: async (remotePath, bytes) => {
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => { await rm(remotePath, { recursive: true, force: true }); },
      run: async (command) => { await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 }); },
    };
    const captured: SandboxSyncOperation[] = [];
    attachCapturingSyncIn(client, captured);

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: assetDir }],
    });

    const findMapping = (base: string) =>
      captured
        .flatMap((op) => op.files)
        .find((mapping) => path.posix.basename(mapping.targetPath) === base);

    // The workspace, git-history, and asset destinations receive read-write bytes,
    // so the author marks each mapping `access: "rw"`.
    expect(findMapping("workspace-upload.tar")?.access).toBe("rw");
    expect(findMapping("git-workspace-upload.tar")?.access).toBe("rw");
    expect(findMapping("home-upload.tar")?.access).toBe("rw");

    // Each tar mapping uploads a staging archive under the runtime root, so its
    // `targetPath` is not the read-write destination. `writablePath` names the
    // directory that the post-upload extract command fills: the workspace
    // directory for the workspace and git tars, and the asset directory for the
    // asset tar.
    const remoteAssetDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "test-adapter", "home");
    expect(findMapping("workspace-upload.tar")?.writablePath).toBe(remoteWorkspaceDir);
    expect(findMapping("git-workspace-upload.tar")?.writablePath).toBe(remoteWorkspaceDir);
    expect(findMapping("home-upload.tar")?.writablePath).toBe(remoteAssetDir);
  });

  it("authors the advisory access intent ro on referenced-project inbound mappings", async () => {
    const flagKey = "PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC";
    const priorFlag = process.env[flagKey];
    process.env[flagKey] = "1";
    try {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-access-ro-"));
      cleanupDirs.push(rootDir);
      const localWorkspaceDir = path.join(rootDir, "local-workspace");
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      const referencedDir = path.join(rootDir, "referenced-project");
      await mkdir(localWorkspaceDir, { recursive: true });
      await mkdir(referencedDir, { recursive: true });
      await writeFile(path.join(localWorkspaceDir, "README.md"), "anchor\n", "utf8");
      await writeFile(path.join(referencedDir, "notes.md"), "reference\n", "utf8");

      const client: SandboxManagedRuntimeClient = {
        makeDir: async (remotePath) => { await mkdir(remotePath, { recursive: true }); },
        writeFile: async (remotePath, bytes) => {
          await mkdir(path.dirname(remotePath), { recursive: true });
          await writeFile(remotePath, Buffer.from(bytes));
        },
        readFile: async (remotePath) => await readFile(remotePath),
        listFiles: async () => [],
        remove: async (remotePath) => { await rm(remotePath, { recursive: true, force: true }); },
        run: async (command) => { await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 }); },
      };
      const captured: SandboxSyncOperation[] = [];
      attachCapturingSyncIn(client, captured);

      await prepareSandboxManagedRuntime({
        spec: {
          transport: "sandbox",
          provider: "test",
          sandboxId: "sandbox-1",
          remoteCwd: remoteWorkspaceDir,
          timeoutMs: 30_000,
          apiKey: null,
        },
        adapterKey: "test-adapter",
        client,
        workspaceLocalDir: localWorkspaceDir,
        additionalSources: [{ localPath: referencedDir, projectId: "proj-first" }],
      });

      const referencedMapping = captured
        .flatMap((op) => op.files)
        .find((mapping) => path.posix.basename(mapping.targetPath) === "project-proj-first");

      // A referenced project is a read-only tree, so the author marks it `access: "ro"`.
      expect(referencedMapping).toBeDefined();
      expect(referencedMapping?.kind).toBe("directory");
      expect(referencedMapping?.access).toBe("ro");
    } finally {
      if (priorFlag === undefined) delete process.env[flagKey];
      else process.env[flagKey] = priorFlag;
    }
  });

  it("keeps the sandbox runtime core free of Codex-specific string literals", async () => {
    const coreSource = await readFile(new URL("./sandbox-managed-runtime.ts", import.meta.url), "utf8");
    // The seam must be generic: no adapter (Codex) knowledge may live in the core.
    expect(coreSource).not.toMatch(/codex/i);
    expect(coreSource).not.toMatch(/auth\.json/i);
    expect(coreSource).not.toMatch(/merge-extract|merge-decision/i);
  });

  // End-to-end: drive the WHOLE prepare path — `prepareCommandManagedRuntime`
  // building the client, syncing the anchor workspace, then staging the
  // referenced projects — through a runner that runs real shell commands on the
  // host filesystem (host FS stands in for the sandbox FS). The runner exposes no
  // native syncIn, so staging rides the base64/tar fallback, the same transport a
  // provider without native sync uses. In production the kill-switch
  // `PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC` gates whether run prep resolves any
  // referenced projects (OFF ⇒ none reach this layer). Enable it in-test only to
  // model the ON scenario, and prove multi-project isolation plus one-failure
  // isolation end-to-end.
  it("stages multiple referenced projects into isolated sandbox dirs end-to-end, skipping a failing source", async () => {
    const flagKey = "PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC";
    const priorFlag = process.env[flagKey];
    process.env[flagKey] = "1";
    try {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-e2e-additional-"));
      cleanupDirs.push(rootDir);

      const localWorkspaceDir = path.join(rootDir, "local-workspace");
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      await mkdir(localWorkspaceDir, { recursive: true });
      await mkdir(remoteWorkspaceDir, { recursive: true });
      await writeFile(path.join(localWorkspaceDir, "README.md"), "anchor content\n", "utf8");

      // Two real referenced-project checkouts (one with a nested file) plus a
      // deliberately-missing source between them.
      const first = path.join(rootDir, "referenced-first");
      const second = path.join(rootDir, "referenced-second");
      await mkdir(path.join(first, "docs"), { recursive: true });
      await mkdir(second, { recursive: true });
      await writeFile(path.join(first, "docs", "guide.md"), "first guide\n", "utf8");
      await writeFile(path.join(second, "notes.md"), "second notes\n", "utf8");

      const runner: CommandManagedRuntimeRunner = {
        execute: (input) =>
          new Promise<RunProcessResult>((resolve) => {
            const startedAt = new Date().toISOString();
            const command =
              input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
            const child = spawn(command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env } });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
            child.on("error", () => resolve({ exitCode: 127, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt }));
            child.on("close", (code) => resolve({ exitCode: code ?? 0, signal: null, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt }));
            if (input.stdin != null) child.stdin.write(input.stdin);
            child.stdin.end();
          }),
      };

      const prepared = await prepareCommandManagedRuntime({
        runner,
        spec: { remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000 },
        adapterKey: "test-adapter",
        workspaceLocalDir: localWorkspaceDir,
        additionalSources: [
          { localPath: first, projectId: "proj-first" },
          { localPath: path.join(rootDir, "referenced-missing"), projectId: "proj-missing" },
          { localPath: second, projectId: "proj-second" },
        ],
      });

      const runtimeRootDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "test-adapter");

      // The anchor workspace synced normally and stays byte-identical.
      await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("anchor content\n");

      // Each healthy referenced project landed in its OWN isolated dir; the
      // missing one is skipped, not fatal.
      expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["proj-first", "proj-second"]);
      expect(prepared.additionalSourceDirs["proj-first"]).toBe(path.posix.join(runtimeRootDir, "project-proj-first"));
      expect(prepared.additionalSourceDirs["proj-second"]).toBe(path.posix.join(runtimeRootDir, "project-proj-second"));
      expect(prepared.additionalSourceDirs["proj-missing"]).toBeUndefined();

      // The skipped project is a first-class per-project failure outcome, not only a warning, so the
      // run can count it in the requested-vs-synced accounting. The two healthy projects do not
      // appear as failures.
      expect(prepared.additionalSourceFailures.map((failure) => failure.projectId)).toEqual([
        "proj-missing",
      ]);
      expect(prepared.additionalSourceFailures[0]!.error.length).toBeGreaterThan(0);

      await expect(readFile(path.join(prepared.additionalSourceDirs["proj-first"], "docs", "guide.md"), "utf8"))
        .resolves.toBe("first guide\n");
      await expect(readFile(path.join(prepared.additionalSourceDirs["proj-second"], "notes.md"), "utf8"))
        .resolves.toBe("second notes\n");

      // Neither project's tree leaked into the anchor workspace or into the other
      // project's dir.
      await expect(readFile(path.join(remoteWorkspaceDir, "notes.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(prepared.additionalSourceDirs["proj-first"], "notes.md"), "utf8")).rejects
        .toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(runtimeRootDir, "project-proj-missing"), "utf8")).rejects
        .toMatchObject({ code: "ENOENT" });
    } finally {
      if (priorFlag === undefined) delete process.env[flagKey];
      else process.env[flagKey] = priorFlag;
    }
  });

  it("builds the workspace tarball inside one host pack span for a usual workspace sync", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pack-span-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace body\n", "utf8");

    // Record every span name the runner opens and run the wrapped work, so the
    // test proves the host opens a span around each host-side staging sub-step
    // for the usual (plain) workspace sync: the git enumeration, the baseline
    // content-hash walk, and the tarball build, in that order.
    const openedSpans: string[] = [];
    const runtimeSpan: RuntimeSpanRunner = async (name, work) => {
      openedSpans.push(name);
      return await work();
    };

    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-pack",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client: makeFilesystemClient(),
      workspaceLocalDir: localWorkspaceDir,
      runtimeSpan,
    });

    // The workspace stage task opens its own `stage.workspace` span, and the
    // host tarball build opens the `pack` span inside it. The two pre-task
    // sub-steps stay ahead of the task.
    expect(openedSpans).toEqual(["snapshot.git", "snapshot.baseline", "stage.workspace", "pack"]);
    // The tarball build still lands the workspace inside the span, so the wrap
    // changes no staging behavior.
    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("workspace body\n");
    expect(prepared.workspaceRemoteDir).toBe(remoteWorkspaceDir);
  });

  it("nests the host pack span under the stage.workspace task span", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pack-nest-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace body\n", "utf8");

    const { traceContext, spans } = createRecordingTraceContext();
    // The root span stands in for `sandbox.startup`. Its child context is the
    // step span's parent, exactly as the executor wires it.
    const rootHandle = traceContext.tracer.startSpan("sandbox.startup", undefined, undefined);
    const rootContext = traceContext.contextWithSpan(rootHandle);

    // The stage runner parents each span to the ACTIVE startup step, so the
    // `pack` span nests under `stage.sync`. This is the exact runner the
    // executor threads into the staging seam.
    const stageRuntimeSpan = createRuntimeSpanRunner(
      traceContext,
      () => getActiveStepContext()?.parentContext,
    );

    // A deterministic monotonic clock, so the step timing stays test-stable.
    let clock = 0;
    const now = () => (clock += 1000);

    await measureStartupStep(
      {},
      now,
      "stage.sync",
      async () => {
        await prepareSandboxManagedRuntime({
          spec: {
            transport: "sandbox",
            provider: "test",
            sandboxId: "sandbox-nest",
            remoteCwd: remoteWorkspaceDir,
            timeoutMs: 30_000,
            apiKey: null,
          },
          adapterKey: "test-adapter",
          client: makeFilesystemClient(),
          workspaceLocalDir: localWorkspaceDir,
          runtimeSpan: stageRuntimeSpan,
        });
      },
      {
        tracer: traceContext.tracer,
        parentContext: rootContext,
        contextWithSpan: (span) => traceContext.contextWithSpan(span),
      },
    );

    const stageSpan = spans.find((span) => span.name === "stage.sync");
    const workspaceSpan = spans.find((span) => span.name === "stage.workspace");
    const packSpan = spans.find((span) => span.name === "pack");
    expect(stageSpan).toBeDefined();
    expect(workspaceSpan).toBeDefined();
    expect(packSpan).toBeDefined();
    expect(packSpan!.ended).toBe(true);
    // The workspace stage task opens its own `stage.workspace` span under
    // `stage.sync`, and the `pack` span nests under `stage.workspace`.
    expect(workspaceSpan!.parentName).toBe("stage.sync");
    expect(packSpan!.parentName).toBe("stage.workspace");

    // The two pre-`pack` staging sub-steps nest under `stage.sync` the same way,
    // so the previously hidden gap at the head of the step is now attributed.
    for (const name of ["snapshot.git", "snapshot.baseline"]) {
      const span = spans.find((candidate) => candidate.name === name);
      expect(span, name).toBeDefined();
      expect(span!.ended).toBe(true);
      expect(span!.parentName).toBe("stage.sync");
    }
  });
});

// A deferred promise a test resolves or rejects by hand.
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settleTick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A span recorder that captures each opened span name and the set of spans that
// are open right now. `opened` records every span in open order. `openNow` holds
// the names of the spans that started but did not end yet, so a test proves two
// concurrent tasks keep their spans open at the same time.
function makeSpanRecorder(): {
  runtimeSpan: RuntimeSpanRunner;
  opened: string[];
  openNow: Set<string>;
} {
  const opened: string[] = [];
  const openNow = new Set<string>();
  const runtimeSpan: RuntimeSpanRunner = async (name, work) => {
    opened.push(name);
    openNow.add(name);
    try {
      return await work();
    } finally {
      openNow.delete(name);
    }
  };
  return { runtimeSpan, opened, openNow };
}

// A controlled `syncIn` client. It labels each inbound operation, records the
// start and settle order, and lets a test hold one upload open, release it, or
// make it fail. One operation rides each `syncIn` call, so one call maps to one
// label. This exercises the inbound coordinator's schedule, bound, failure
// semantics, and startup barrier with deferred-promise fakes.
interface SyncControl {
  started: string[];
  settled: string[];
  waitForStart(label: string): Promise<void>;
  hold(label: string): void;
  release(label: string): void;
  failWith(label: string, error: Error): void;
}

function labelOfOperation(operation: SandboxSyncOperation): string {
  const bases = operation.files.map((mapping) => path.posix.basename(mapping.targetPath));
  if (bases.some((base) => base === "workspace-upload.tar" || base === "git-workspace-upload.tar")) {
    return "workspace";
  }
  const assetBase = bases.find((base) => base.endsWith("-upload.tar"));
  if (assetBase) {
    return assetBase.slice(0, -"-upload.tar".length);
  }
  const projectBase = bases.find((base) => base.startsWith("project-"));
  if (projectBase) {
    return projectBase;
  }
  return bases[0] ?? operation.operationId;
}

function makeControlledSyncClient(options: { concurrent: boolean }): {
  client: SandboxManagedRuntimeClient;
  control: SyncControl;
} {
  const started: string[] = [];
  const settled: string[] = [];
  const gates = new Map<string, Deferred<void>>();
  const failures = new Map<string, Error>();
  const startWaiters = new Map<string, Array<() => void>>();

  const control: SyncControl = {
    started,
    settled,
    waitForStart(label) {
      if (started.includes(label)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiters = startWaiters.get(label) ?? [];
        waiters.push(resolve);
        startWaiters.set(label, waiters);
      });
    },
    hold(label) {
      if (!gates.has(label)) {
        gates.set(label, defer<void>());
      }
    },
    release(label) {
      gates.get(label)?.resolve();
    },
    failWith(label, error) {
      failures.set(label, error);
      gates.get(label)?.resolve();
    },
  };

  const noop = async (): Promise<void> => {};
  const client: SandboxManagedRuntimeClient = {
    makeDir: noop,
    writeFile: noop,
    readFile: async () => Buffer.alloc(0),
    listFiles: async () => [],
    remove: noop,
    run: noop,
    allowConcurrentSyncOperations: options.concurrent,
    syncIn: async (operations) => {
      const operation = operations[0]!;
      const label = labelOfOperation(operation);
      started.push(label);
      const waiters = startWaiters.get(label) ?? [];
      startWaiters.delete(label);
      for (const waiter of waiters) {
        waiter();
      }
      try {
        const gate = gates.get(label);
        if (gate) {
          await gate.promise;
        }
        const failure = failures.get(label);
        if (failure) {
          throw failure;
        }
        return {
          operations: [{
            operationId: operation.operationId,
            filesTransferred: operation.files.length,
            bytesTransferred: 0,
          }],
        };
      } finally {
        settled.push(label);
      }
    },
  };

  return { client, control };
}

describe("sandbox managed runtime inbound coordinator", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function makeSpec(remoteCwd: string) {
    return {
      transport: "sandbox" as const,
      provider: "test",
      sandboxId: "sandbox-1",
      remoteCwd,
      timeoutMs: 30_000,
      apiKey: null,
    };
  }

  // Create a temp root with one workspace directory and any named asset/project
  // directories. Each directory carries one file, so the host tar step has bytes.
  async function makeInboundDirs(names: string[]): Promise<{
    rootDir: string;
    workspaceDir: string;
    dirOf: (name: string) => string;
  }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-inbound-coordinator-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "file.txt"), "workspace\n", "utf8");
    const dirs = new Map<string, string>();
    for (const name of names) {
      const dir = path.join(rootDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "file.txt"), `${name}\n`, "utf8");
      dirs.set(name, dir);
    }
    return { rootDir, workspaceDir, dirOf: (name) => dirs.get(name)! };
  }

  // Resolve true when the label started within the window, false on timeout.
  async function startedWithin(control: SyncControl, label: string, ms: number): Promise<boolean> {
    return Promise.race([
      control.waitForStart(label).then(() => true),
      settleTick(ms).then(() => false),
    ]);
  }

  it("with concurrency permitted, the home asset upload starts while the workspace upload is held open", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["home"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    control.hold("workspace");

    const prepared = prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "home", localDir: dirOf("home") }],
    });
    prepared.catch(() => undefined);

    // The workspace upload is open and held. The home asset upload still starts,
    // so the coordinator runs the two operations concurrently.
    await control.waitForStart("workspace");
    expect(await startedWithin(control, "home", 4000)).toBe(true);
    expect(control.settled).not.toContain("workspace");

    control.release("workspace");
    await prepared;
    expect(control.settled).toContain("home");
  });

  it("with five operations and the bound of 4, the fifth operation does not start while four stay open", async () => {
    expect(SYNC_OPERATION_CONCURRENCY_LIMIT).toBe(4);
    const assetKeys = Array.from(
      { length: SYNC_OPERATION_CONCURRENCY_LIMIT + 1 },
      (_unused, index) => `asset-${index}`,
    );
    const { workspaceDir, dirOf } = await makeInboundDirs(assetKeys);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    for (const key of assetKeys) {
      control.hold(key);
    }

    const prepared = prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      syncWorkspace: false,
      workspaceLocalDir: workspaceDir,
      assets: assetKeys.map((key) => ({ key, localDir: dirOf(key) })),
    });
    prepared.catch(() => undefined);

    const firstFour = assetKeys.slice(0, SYNC_OPERATION_CONCURRENCY_LIMIT);
    const fifth = assetKeys[SYNC_OPERATION_CONCURRENCY_LIMIT]!;
    for (const key of firstFour) {
      await control.waitForStart(key);
    }
    // The bound holds the fifth operation while four stay open.
    expect(await startedWithin(control, fifth, 300)).toBe(false);
    expect(control.started.slice().sort()).toEqual(firstFour.slice().sort());

    // One release frees one slot, so the fifth operation starts.
    control.release(firstFour[0]!);
    expect(await startedWithin(control, fifth, 4000)).toBe(true);

    for (const key of assetKeys) {
      control.release(key);
    }
    await prepared;
    expect(control.settled.slice().sort()).toEqual(assetKeys.slice().sort());
  });

  it("holds one upload open after another upload fails, and returns only after both settle", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["asset-a", "asset-b"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    control.hold("asset-b");

    let coordinatorSettled = false;
    const prepared = prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      syncWorkspace: false,
      workspaceLocalDir: workspaceDir,
      assets: [
        { key: "asset-a", localDir: dirOf("asset-a") },
        { key: "asset-b", localDir: dirOf("asset-b") },
      ],
    });
    const done = prepared.then(
      () => { coordinatorSettled = true; },
      () => { coordinatorSettled = true; },
    );

    control.failWith("asset-a", new Error("asset-a-fail"));
    await control.waitForStart("asset-b");
    await settleTick(100);

    // The first upload already failed. The second upload is still open, so the
    // coordinator must not return yet.
    expect(coordinatorSettled).toBe(false);
    expect(control.settled).toContain("asset-a");
    expect(control.settled).not.toContain("asset-b");

    control.release("asset-b");
    await done;
    expect(coordinatorSettled).toBe(true);
    expect(control.settled).toEqual(expect.arrayContaining(["asset-a", "asset-b"]));
  });

  it("records a referenced-project failure as nonfatal and finishes the other referenced-project uploads", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["good", "bad"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    control.failWith("project-bad", new Error("bad-upload"));

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      syncWorkspace: false,
      workspaceLocalDir: workspaceDir,
      additionalSources: [
        { localPath: dirOf("good"), projectId: "good" },
        { localPath: dirOf("bad"), projectId: "bad" },
      ],
    });

    // The healthy project synced; the failed project is a recorded, nonfatal
    // outcome, so the coordinator resolved.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["good"]);
    expect(prepared.additionalSourceFailures.map((failure) => failure.projectId)).toEqual(["bad"]);
    expect(prepared.additionalSourceFailures[0]!.error).toContain("bad-upload");
    expect(control.settled).toContain("project-good");
  });

  it("raises an asset failure as fatal after the barrier", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["asset-good", "asset-bad"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    control.failWith("asset-bad", new Error("asset-bad-fail"));

    await expect(
      prepareSandboxManagedRuntime({
        spec: makeSpec("/remote/cwd"),
        adapterKey: "codex",
        client,
        syncWorkspace: false,
        workspaceLocalDir: workspaceDir,
        assets: [
          { key: "asset-good", localDir: dirOf("asset-good") },
          { key: "asset-bad", localDir: dirOf("asset-bad") },
        ],
      }),
    ).rejects.toThrow("asset-bad-fail");

    // The barrier still settles the healthy asset before the coordinator raises.
    expect(control.settled).toContain("asset-good");
  });

  it("raises the earlier required failure when the workspace and an asset both fail", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["asset-a"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    control.failWith("workspace", new Error("workspace-fail"));
    control.failWith("asset-a", new Error("asset-a-fail"));

    // The workspace comes before the asset in stable operation order, so the
    // coordinator raises the workspace failure.
    await expect(
      prepareSandboxManagedRuntime({
        spec: makeSpec("/remote/cwd"),
        adapterKey: "codex",
        client,
        workspaceLocalDir: workspaceDir,
        assets: [{ key: "asset-a", localDir: dirOf("asset-a") }],
      }),
    ).rejects.toThrow("workspace-fail");
  });

  it("with concurrency forbidden, keeps the serial schedule in the current order", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["asset-a"]);
    const { client, control } = makeControlledSyncClient({ concurrent: false });
    control.hold("workspace");

    const prepared = prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "asset-a", localDir: dirOf("asset-a") }],
    });
    prepared.catch(() => undefined);

    // The workspace runs first and is held open. Serial mode runs one operation
    // at a time, so the asset upload does not start until the workspace settles.
    await control.waitForStart("workspace");
    expect(await startedWithin(control, "asset-a", 300)).toBe(false);
    expect(control.started).toEqual(["workspace"]);

    control.release("workspace");
    await control.waitForStart("asset-a");
    await prepared;
    // The serial order stays workspace first, then the asset.
    expect(control.started).toEqual(["workspace", "asset-a"]);
  });

  it("opens one named span per inbound task: stage.workspace, stage.asset.<key>, stage.project.<id>", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["home", "proj"]);
    const { client } = makeControlledSyncClient({ concurrent: false });
    const { runtimeSpan, opened } = makeSpanRecorder();

    await prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "home", localDir: dirOf("home") }],
      additionalSources: [{ localPath: dirOf("proj"), projectId: "proj-1" }],
      runtimeSpan,
    });

    // Each inbound task carries its own named span. The workspace task, the home
    // asset task, and the referenced-project task each open one.
    expect(opened).toContain("stage.workspace");
    expect(opened).toContain("stage.asset.home");
    expect(opened).toContain("stage.project.proj-1");
  });

  it("with concurrency permitted, the workspace and asset inbound task spans overlap in time", async () => {
    const { workspaceDir, dirOf } = await makeInboundDirs(["home"]);
    const { client, control } = makeControlledSyncClient({ concurrent: true });
    const { runtimeSpan, openNow } = makeSpanRecorder();
    control.hold("workspace");
    control.hold("home");

    const prepared = prepareSandboxManagedRuntime({
      spec: makeSpec("/remote/cwd"),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "home", localDir: dirOf("home") }],
      runtimeSpan,
    });
    prepared.catch(() => undefined);

    // Both uploads are held open at their transfer. Each task span opens before
    // its transfer and stays open while the transfer is held, so the two spans
    // are open at the same time.
    await control.waitForStart("workspace");
    await control.waitForStart("home");
    expect(openNow.has("stage.workspace")).toBe(true);
    expect(openNow.has("stage.asset.home")).toBe(true);

    control.release("workspace");
    control.release("home");
    await prepared;
  });
});

// A controlled outbound restore. It reuses the deferred-promise fakes. The
// native `syncOut` copies the sandbox workspace back into the restore temp
// directory, and a gate holds the workspace restore open. Each asset carries a
// controlled `restore` callback the test can hold, release, or make fail. One
// label rides the workspace restore and one label rides each asset restore, so
// a test can watch the outbound coordinator schedule, bound, failure semantics,
// and teardown barrier.
interface OutboundControl {
  started: string[];
  settled: string[];
  restoreTempDirs: Map<string, string | undefined>;
  waitForStart(label: string): Promise<void>;
  hold(label: string): void;
  release(label: string): void;
  failWith(label: string, error: Error): void;
}

function makeOutboundControl(): {
  control: OutboundControl;
  gate: <T>(label: string, run: () => Promise<T>) => Promise<T>;
} {
  const started: string[] = [];
  const settled: string[] = [];
  const restoreTempDirs = new Map<string, string | undefined>();
  const gates = new Map<string, Deferred<void>>();
  const failures = new Map<string, Error>();
  const startWaiters = new Map<string, Array<() => void>>();

  const control: OutboundControl = {
    started,
    settled,
    restoreTempDirs,
    waitForStart(label) {
      if (started.includes(label)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiters = startWaiters.get(label) ?? [];
        waiters.push(resolve);
        startWaiters.set(label, waiters);
      });
    },
    hold(label) {
      if (!gates.has(label)) {
        gates.set(label, defer<void>());
      }
    },
    release(label) {
      gates.get(label)?.resolve();
    },
    failWith(label, error) {
      failures.set(label, error);
      gates.get(label)?.resolve();
    },
  };

  // Record the task start, notify start waiters, wait for the gate, raise a set
  // failure, then run the task body and record the settle. A gate that a test
  // never holds resolves at once, so an unheld task runs straight through.
  async function gate<T>(label: string, run: () => Promise<T>): Promise<T> {
    started.push(label);
    const waiters = startWaiters.get(label) ?? [];
    startWaiters.delete(label);
    for (const waiter of waiters) {
      waiter();
    }
    try {
      const held = gates.get(label);
      if (held) {
        await held.promise;
      }
      const failure = failures.get(label);
      if (failure) {
        throw failure;
      }
      return await run();
    } finally {
      settled.push(label);
    }
  }

  return { control, gate };
}

// A native filesystem client whose `syncOut` copies the sandbox workspace back
// through the gate. The inbound prepare step uses the base64-tar fallback
// `syncIn`. The client opts into concurrency by the flag.
function makeGatedOutboundClient(
  concurrent: boolean,
  gate: <T>(label: string, run: () => Promise<T>) => Promise<T>,
): SandboxManagedRuntimeClient {
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
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    },
    remove: async (remotePath) => {
      await rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
    },
    allowConcurrentSyncOperations: concurrent,
    syncOut: async (operations) =>
      gate("workspace", async () => {
        for (const operation of operations) {
          for (const mapping of operation.files) {
            if (mapping.kind === "directory") {
              await mirrorDirectory(mapping.sourcePath, mapping.targetPath);
            } else {
              await mkdir(path.dirname(mapping.targetPath), { recursive: true });
              await writeFile(mapping.targetPath, await readFile(mapping.sourcePath));
            }
          }
        }
        return {
          operations: operations.map((operation) => ({
            operationId: operation.operationId,
            filesTransferred: operation.files.length,
            bytesTransferred: 0,
          })),
        };
      }),
  };
  attachFallbackSyncIn(client);
  return client;
}

// Build one asset with a controlled `restore`. The restore records its own
// temp directory, then runs through the gate. The temp directory proves that
// two concurrent restore tasks keep separate scratch state.
function makeControlledAsset(
  key: string,
  localDir: string,
  control: OutboundControl,
  gate: <T>(label: string, run: () => Promise<T>) => Promise<T>,
): SandboxManagedRuntimeAsset {
  return {
    key,
    localDir,
    restore: async (ctx) => {
      control.restoreTempDirs.set(key, ctx.tempDir);
      await gate(key, async () => {
        if (ctx.tempDir) {
          await writeFile(path.join(ctx.tempDir, `scratch-${key}.txt`), key, "utf8");
        }
      });
    },
  };
}

describe("sandbox managed runtime outbound coordinator", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function makeSpec(remoteCwd: string) {
    return {
      transport: "sandbox" as const,
      provider: "test",
      sandboxId: "sandbox-1",
      remoteCwd,
      timeoutMs: 30_000,
      apiKey: null,
    };
  }

  // Create a temp root with one workspace directory and any named asset
  // directories. Each directory carries one file, so the host tar step has
  // bytes and the merge has content.
  async function makeOutboundDirs(names: string[]): Promise<{
    rootDir: string;
    workspaceDir: string;
    remoteWorkspaceDir: string;
    dirOf: (name: string) => string;
  }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-outbound-coordinator-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "file.txt"), "workspace\n", "utf8");
    const dirs = new Map<string, string>();
    for (const name of names) {
      const dir = path.join(rootDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "file.txt"), `${name}\n`, "utf8");
      dirs.set(name, dir);
    }
    return { rootDir, workspaceDir, remoteWorkspaceDir, dirOf: (name) => dirs.get(name)! };
  }

  // Resolve true when the label started within the window, false on timeout.
  async function startedWithin(control: OutboundControl, label: string, ms: number): Promise<boolean> {
    return Promise.race([
      control.waitForStart(label).then(() => true),
      settleTick(ms).then(() => false),
    ]);
  }

  it("with concurrency permitted, an asset restore starts while the workspace restore is held open", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["home"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(true, gate);
    control.hold("workspace");

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [makeControlledAsset("home", dirOf("home"), control, gate)],
    });

    const restore = prepared.restoreWorkspace();
    restore.catch(() => undefined);

    // The workspace restore is open and held. The home asset restore still
    // starts, so the coordinator runs the two tasks concurrently.
    await control.waitForStart("workspace");
    expect(await startedWithin(control, "home", 4000)).toBe(true);
    expect(control.settled).not.toContain("workspace");

    control.release("workspace");
    await restore;
    expect(control.settled).toContain("home");
    expect(control.settled).toContain("workspace");
  });

  it("holds one restore open after another restore fails, and returns only after both settle", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["asset-a", "asset-b"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(true, gate);

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      syncWorkspace: false,
      workspaceLocalDir: workspaceDir,
      assets: [
        makeControlledAsset("asset-a", dirOf("asset-a"), control, gate),
        makeControlledAsset("asset-b", dirOf("asset-b"), control, gate),
      ],
    });

    control.hold("asset-b");
    control.failWith("asset-a", new Error("asset-a-fail"));

    let coordinatorSettled = false;
    const done = prepared.restoreWorkspace().then(
      () => { coordinatorSettled = true; },
      () => { coordinatorSettled = true; },
    );

    await control.waitForStart("asset-b");
    await settleTick(100);

    // The first restore already failed. The second restore is still open, so
    // the coordinator must not return yet.
    expect(coordinatorSettled).toBe(false);
    expect(control.settled).toContain("asset-a");
    expect(control.settled).not.toContain("asset-b");

    control.release("asset-b");
    await done;
    expect(coordinatorSettled).toBe(true);
    expect(control.settled).toEqual(expect.arrayContaining(["asset-a", "asset-b"]));
  });

  it("with concurrency forbidden, keeps the serial restore schedule in the current order", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["asset-a"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(false, gate);
    control.hold("workspace");

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [makeControlledAsset("asset-a", dirOf("asset-a"), control, gate)],
    });

    const restore = prepared.restoreWorkspace();
    restore.catch(() => undefined);

    // The workspace restore runs first and is held open. Serial mode runs one
    // task at a time, so the asset restore does not start until the workspace
    // restore settles.
    await control.waitForStart("workspace");
    expect(await startedWithin(control, "asset-a", 300)).toBe(false);
    expect(control.started).toEqual(["workspace"]);

    control.release("workspace");
    await control.waitForStart("asset-a");
    await restore;
    // The serial order stays the workspace restore first, then the asset.
    expect(control.started).toEqual(["workspace", "asset-a"]);
  });

  it("with concurrency permitted, two concurrent restore tasks use separate temporary state", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["asset-a", "asset-b"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(true, gate);

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      syncWorkspace: false,
      workspaceLocalDir: workspaceDir,
      assets: [
        makeControlledAsset("asset-a", dirOf("asset-a"), control, gate),
        makeControlledAsset("asset-b", dirOf("asset-b"), control, gate),
      ],
    });

    control.hold("asset-a");
    control.hold("asset-b");
    const restore = prepared.restoreWorkspace();

    // Both restore tasks start together under the bound. Each task carries its
    // own restore temp directory, so the two directories differ.
    await control.waitForStart("asset-a");
    await control.waitForStart("asset-b");
    const tempA = control.restoreTempDirs.get("asset-a");
    const tempB = control.restoreTempDirs.get("asset-b");
    expect(tempA).toBeTruthy();
    expect(tempB).toBeTruthy();
    expect(tempA).not.toBe(tempB);
    expect(tempA!).toContain("paperclip-sandbox-restore-");
    expect(tempB!).toContain("paperclip-sandbox-restore-");

    control.release("asset-a");
    control.release("asset-b");
    await restore;
    expect(control.settled).toEqual(expect.arrayContaining(["asset-a", "asset-b"]));
  });

  it("opens one named span per outbound restore task: restore.workspace, restore.asset.<key>", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["home"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(true, gate);
    const { runtimeSpan, opened } = makeSpanRecorder();

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [makeControlledAsset("home", dirOf("home"), control, gate)],
      runtimeSpan,
    });

    await prepared.restoreWorkspace();

    // Each outbound restore task carries its own named span. The workspace
    // restore task and the home asset restore task each open one.
    expect(opened).toContain("restore.workspace");
    expect(opened).toContain("restore.asset.home");
  });

  it("with concurrency permitted, the workspace and asset restore task spans overlap in time", async () => {
    const { workspaceDir, remoteWorkspaceDir, dirOf } = await makeOutboundDirs(["home"]);
    const { control, gate } = makeOutboundControl();
    const client = makeGatedOutboundClient(true, gate);
    const { runtimeSpan, openNow } = makeSpanRecorder();

    const prepared = await prepareSandboxManagedRuntime({
      spec: makeSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client,
      workspaceLocalDir: workspaceDir,
      assets: [makeControlledAsset("home", dirOf("home"), control, gate)],
      runtimeSpan,
    });

    control.hold("workspace");
    control.hold("home");
    const restore = prepared.restoreWorkspace();
    restore.catch(() => undefined);

    // Both restore tasks are held open. Each restore task span opens before its
    // work and stays open while the work is held, so the two spans are open at
    // the same time.
    await control.waitForStart("workspace");
    await control.waitForStart("home");
    expect(openNow.has("restore.workspace")).toBe(true);
    expect(openNow.has("restore.asset.home")).toBe(true);

    control.release("workspace");
    control.release("home");
    await restore;
  });
});
