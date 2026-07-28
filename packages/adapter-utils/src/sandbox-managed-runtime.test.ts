import { promises as fsPromises } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalGitIndexToHead } from "./git-workspace-sync.js";

import {
  mirrorDirectory,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "./sandbox-managed-runtime.js";

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
    expect(runtimeStatuses.some((status) => (
      status.phase === "git_sync" &&
      /^Syncing git history to sandbox: 100% \(\d+\.\d\/\d+\.\d MB\)$/.test(status.message)
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

    // Two operations: git-workspace then workspace overlay. Each uploads a single
    // tar as a `file` mapping and carries its extract as an ordered post-command.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const gitOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("git-workspace-upload.tar")),
    );
    const workspaceOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("workspace-upload.tar")),
    );
    expect(gitOp).toBeDefined();
    expect(workspaceOp).toBeDefined();
    expect(gitOp!.files.every((mapping) => mapping.kind === "file")).toBe(true);
    // The git operation's post-upload command preserves `.paperclip-runtime` while
    // replacing the rest of the tree (wipe-except-preserved), then untars.
    const gitCommand = gitOp!.postUploadCommands![0].command;
    expect(gitCommand).toContain(".paperclip-runtime");
    expect(gitCommand).toContain("tar -xf");

    // The pre-seeded runtime dir survived the git+workspace staging.
    await expect(
      readFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "keep.txt"), "utf8"),
    ).resolves.toBe("keep\n");
    await expect(readFile(path.join(remoteWorkspaceDir, "tracked.txt"), "utf8")).resolves.toBe("tracked\n");
    expect(prepared.workspaceRemoteDir).toBe(remoteWorkspaceDir);
  });

  // Regression lock: a representative `codex_local` start stages its inbound
  // bytes — git history, workspace overlay, and the managed Codex `home` asset
  // (auth.json merge) — as EXACTLY ONE `syncIn` operation each. Every inbound step
  // is routed through `client.syncIn` (one native `uploadFiles` round-trip per
  // operation, with the extract/merge carried as provider-executed
  // `postUploadCommands`), with no separate custom-provision diversion. Assert
  // the collapsed round-trip count so a future change that re-inlines a
  // `writeFile`+`run` sequence — or fans one staging step across multiple
  // operations — fails loudly here instead of silently regressing the start path.
  it("collapses a representative codex_local start to one syncIn round-trip per inbound staging step", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-codex-roundtrip-"));
    cleanupDirs.push(rootDir);
    const sourceRepoDir = path.join(rootDir, "source-repo");
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");

    // Git-backed workspace → git history + workspace overlay are two staging steps.
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

    // The collapsed count: exactly three inbound round-trips — git, workspace, home.
    expect(captured).toHaveLength(3);
    const gitOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("git-workspace-upload.tar")),
    );
    const workspaceOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("workspace-upload.tar")),
    );
    const homeOp = captured.find((op) =>
      op.files.some((mapping) => mapping.targetPath.endsWith("home-upload.tar")),
    );
    expect(gitOp).toBeDefined();
    expect(workspaceOp).toBeDefined();
    expect(homeOp).toBeDefined();

    // Every operation is a single native uploadFiles (all `file` mappings) whose
    // extract/merge rides as an ordered provider-executed post-upload command.
    for (const op of captured) {
      expect(op.files.length).toBeGreaterThanOrEqual(1);
      expect(op.files.every((mapping) => mapping.kind === "file")).toBe(true);
      expect(op.postUploadCommands ?? []).not.toHaveLength(0);
    }
    // Operation ids are distinct, so "3 operations" is 3 real round-trips.
    expect(new Set(captured.map((op) => op.operationId)).size).toBe(3);

    // The credential asset actually materialized through the native seam.
    await expect(readFile(path.join(prepared.assetDirs.home, "auth.json"), "utf8"))
      .resolves.toBe("{\"OPENAI_API_KEY\":\"sk-test\"}\n");
  });

  it("keeps the sandbox runtime core free of Codex-specific string literals", async () => {
    const coreSource = await readFile(new URL("./sandbox-managed-runtime.ts", import.meta.url), "utf8");
    // The seam must be generic: no adapter (Codex) knowledge may live in the core.
    expect(coreSource).not.toMatch(/codex/i);
    expect(coreSource).not.toMatch(/auth\.json/i);
    expect(coreSource).not.toMatch(/merge-extract|merge-decision/i);
  });
});
