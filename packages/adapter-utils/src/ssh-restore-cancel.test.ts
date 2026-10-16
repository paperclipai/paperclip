import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
});
