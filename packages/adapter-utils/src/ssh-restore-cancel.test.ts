import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isWorkspaceRestoreCancelled,
  restoreWorkspaceFromSshExecution,
  syncDirectoryFromSsh,
  throwIfWorkspaceRestoreAborted,
  WORKSPACE_RESTORE_CANCELLED,
  workspaceRestoreCancelledError,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import {
  captureDirectorySnapshot,
  mergeDirectoryWithBaseline,
} from "./workspace-restore-merge.js";

/**
 * Regression for TOG-25014: two SSH runs ended their logs at
 * `Restoring workspace from ssh: 100%` and then stayed `running` for 20-65
 * minutes with no live worker. The 100% line only covers the remote tarball
 * stream; the silent local clear + copy/merge into the shared checkout ran
 * afterwards with no cancellation checks, so an operator Stop could not
 * terminalize the run until the multi-GB apply finished.
 *
 * These tests pin the repair: a pre-aborted run-scoped signal makes every
 * restore entry point yield promptly with `workspace_restore_cancelled`
 * without touching the local checkout, while a live (non-aborted) restore
 * keeps its full behavior. All cases are hermetic: the aborted paths throw
 * before any SSH spawn, and the merge cases use local temp dirs only.
 */
describe("ssh workspace restore cancellation", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  // Never dialed: every aborted case below throws before the first SSH spawn.
  function unreachableSpec(): SshRemoteExecutionSpec {
    return {
      host: "127.0.0.1",
      port: 1,
      username: "paperclip-test",
      remoteWorkspacePath: "/nonexistent",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
      remoteCwd: "/nonexistent",
    };
  }

  function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort(new Error("test stop"));
    return controller.signal;
  }

  it("classifies the typed cancellation error", () => {
    expect(WORKSPACE_RESTORE_CANCELLED).toBe("workspace_restore_cancelled");
    expect(isWorkspaceRestoreCancelled(workspaceRestoreCancelledError())).toBe(true);
    expect(isWorkspaceRestoreCancelled(new Error("ssh exited with code 255"))).toBe(false);
    expect(isWorkspaceRestoreCancelled(null)).toBe(false);
    expect(() => throwIfWorkspaceRestoreAborted(abortedSignal())).toThrowError(
      WORKSPACE_RESTORE_CANCELLED,
    );
    expect(() => throwIfWorkspaceRestoreAborted(null)).not.toThrow();
    expect(() => throwIfWorkspaceRestoreAborted(undefined)).not.toThrow();
  });

  it("syncDirectoryFromSsh yields before opening the transfer when cancelled", async () => {
    const localDir = await makeTempDir("paperclip-restore-cancel-");
    await writeFile(path.join(localDir, "sentinel.txt"), "untouched\n", "utf8");
    const progressLines: string[] = [];

    await expect(
      syncDirectoryFromSsh({
        spec: unreachableSpec(),
        remoteDir: "/nonexistent",
        localDir,
        onProgress: (line) => {
          progressLines.push(line);
        },
        progressLabel: "workspace",
        signal: abortedSignal(),
      }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    // The local checkout is untouched: no clear, no copy, no staging residue.
    expect(await readdir(localDir)).toEqual(["sentinel.txt"]);
    expect(await readFile(path.join(localDir, "sentinel.txt"), "utf8")).toBe("untouched\n");
    expect(progressLines.some((line) => line.includes("Skipping SSH workspace restore"))).toBe(true);
  });

  it("restoreWorkspaceFromSshExecution yields before any transfer when cancelled", async () => {
    const localDir = await makeTempDir("paperclip-restore-cancel-");
    await writeFile(path.join(localDir, "sentinel.txt"), "untouched\n", "utf8");
    const progressLines: string[] = [];

    await expect(
      restoreWorkspaceFromSshExecution({
        spec: unreachableSpec(),
        localDir,
        onProgress: (line) => {
          progressLines.push(line);
        },
        signal: abortedSignal(),
      }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    expect(await readdir(localDir)).toEqual(["sentinel.txt"]);
    expect(progressLines.some((line) => line.includes("Skipping SSH workspace restore"))).toBe(true);
  });

  it("captureDirectorySnapshot yields before walking when cancelled", async () => {
    const rootDir = await makeTempDir("paperclip-snapshot-cancel-");
    await writeFile(path.join(rootDir, "file.txt"), "content", "utf8");

    await expect(captureDirectorySnapshot(rootDir, { exclude: [], signal: abortedSignal() }))
      .rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);
  });

  it("mergeDirectoryWithBaseline yields before mutating the target when cancelled", async () => {
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    await writeFile(path.join(sourceDir, "remote-edit.txt"), "from remote\n", "utf8");
    await writeFile(path.join(targetDir, "sentinel.txt"), "untouched\n", "utf8");

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await expect(
      mergeDirectoryWithBaseline({
        baseline,
        sourceDir,
        targetDir,
        signal: abortedSignal(),
      }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    expect(await readdir(targetDir)).toEqual(["sentinel.txt"]);
    expect(await readFile(path.join(targetDir, "sentinel.txt"), "utf8")).toBe("untouched\n");
  });

  it("mergeDirectoryWithBaseline checks cancellation before applying remote deletions", async () => {
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    await writeFile(path.join(targetDir, "remote-deleted.txt"), "preserve until live apply\n", "utf8");
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
    const controller = new AbortController();

    await expect(mergeDirectoryWithBaseline({
      baseline,
      sourceDir,
      targetDir,
      signal: controller.signal,
      beforeApply: async () => controller.abort(),
    })).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    await expect(readFile(path.join(targetDir, "remote-deleted.txt"), "utf8"))
      .resolves.toBe("preserve until live apply\n");
  });

  it("mergeDirectoryWithBaseline still applies the remote snapshot when live", async () => {
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    // The source is the full desired state: unchanged files must be present
    // in both, or the merge correctly treats the absence as a remote deletion.
    await writeFile(path.join(sourceDir, "sentinel.txt"), "untouched\n", "utf8");
    await writeFile(path.join(sourceDir, "remote-edit.txt"), "from remote\n", "utf8");
    await writeFile(path.join(targetDir, "sentinel.txt"), "untouched\n", "utf8");

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });

    expect(await readFile(path.join(targetDir, "remote-edit.txt"), "utf8")).toBe("from remote\n");
    expect(await readFile(path.join(targetDir, "sentinel.txt"), "utf8")).toBe("untouched\n");
  });

  it("syncDirectoryFromSsh clears stale subdirectories and copies read-only trees", async () => {
    // Hermetic live-restore pin for the local clear + copy/merge half of
    // syncDirectoryFromSsh: a fake `ssh` on PATH streams a prebuilt tarball
    // exactly like the remote `tar -cf - .`, so the staging download, local
    // clear and copy run for real with no network or sshd. Pre-fix this
    // failed two ways: the clear emptied each directory and then called
    // fs.rm without `recursive` (ERR_FS_EISDIR after deleting contents),
    // and the copy created each destination with the source mode first, so
    // a read-only source directory rejected its child writes with EACCES.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping live-restore pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    await mkdir(path.join(remoteTree, "nested"), { recursive: true });
    await writeFile(path.join(remoteTree, "nested", "inner.txt"), "from remote\n", "utf8");
    await mkdir(path.join(remoteTree, "readonly-dir"), { recursive: true });
    await writeFile(path.join(remoteTree, "readonly-dir", "child.txt"), "readonly child\n", "utf8");
    await chmod(path.join(remoteTree, "readonly-dir"), 0o555);
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat ${JSON.stringify(tarball)}\n`, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    await mkdir(path.join(localDir, "stale-dir"), { recursive: true });
    await writeFile(path.join(localDir, "stale-dir", "stale.txt"), "stale\n", "utf8");
    await writeFile(path.join(localDir, "stale.txt"), "stale\n", "utf8");

    await syncDirectoryFromSsh({
      spec: unreachableSpec(),
      remoteDir: "/nonexistent",
      localDir,
      signal: null,
    });

    expect((await readdir(localDir)).sort()).toEqual(["nested", "readonly-dir"]);
    expect(await readFile(path.join(localDir, "nested", "inner.txt"), "utf8")).toBe("from remote\n");
    expect(await readFile(path.join(localDir, "readonly-dir", "child.txt"), "utf8")).toBe(
      "readonly child\n",
    );
    // The source mode is applied once the children are copied. The tar
    // extraction runs unprivileged, so the staged source mode already
    // reflects the extractor umask (0555 & ~umask); the copy must preserve
    // exactly that.
    const expectedMode = (0o555 & ~process.umask()) & 0o777;
    expect((await stat(path.join(localDir, "readonly-dir"))).mode & 0o777).toBe(expectedMode);
  });
});
