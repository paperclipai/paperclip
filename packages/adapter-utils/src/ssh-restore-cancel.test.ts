import { execFile } from "node:child_process";
import { existsSync, promises as fsPromises, readdirSync } from "node:fs";
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
 * keeps its full behavior. The mid-flight cases pin the harder half: Stop
 * landing after restore work has begun must yield from the transfer, clear,
 * copy, walk, and merge-apply paths with later entries untouched. All cases
 * are hermetic: the aborted paths throw before any SSH spawn, the live
 * transfer runs against a fake `ssh` on PATH, and the merge cases use local
 * temp dirs only.
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

  // Mid-flight cancellation probe: an AbortSignal-compatible whose `aborted`
  // flips true once `isCancelled()` observes restore work on disk. Fully
  // deterministic — no timers, no scheduling dependence: every cancellation
  // check after the marker appears throws. Removing the per-entry checks
  // under test lets the operation run to completion, failing the test.
  function cancelWhen(isCancelled: () => boolean): AbortSignal {
    return {
      get aborted() {
        return isCancelled();
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;
  }

  // Read-count variant for paths with no on-disk side effect to gate on
  // (snapshot walks). `maxReads` must sit strictly between the entry-check
  // reads and the full-walk reads so the flip lands mid-walk.
  function cancelAfterReads(maxReads: number): AbortSignal {
    let reads = 0;
    return cancelWhen(() => {
      reads += 1;
      return reads > maxReads;
    });
  }

  // Polls until a backgrounded staging delete lands. Only the *cleanup*
  // wait polls: the cancellation itself is gated on on-disk state, so the
  // prompt-return half of the staging-cleanup pins stays deterministic.
  async function waitForPathGone(target: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (existsSync(target) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(target)).toBe(false);
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

  it("syncDirectoryFromSsh restores a read-only tree a second time", async () => {
    // The first restore copies a 0555 directory; the second restore must
    // clear it first. Pre-fix the clear recursed into the read-only directory
    // and the child unlink threw EACCES, failing the whole restore after
    // partially deleting the checkout.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping second-restore pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
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
    const input = {
      spec: unreachableSpec(),
      remoteDir: "/nonexistent",
      localDir,
      signal: null,
    };
    await syncDirectoryFromSsh(input);
    expect(await readFile(path.join(localDir, "readonly-dir", "child.txt"), "utf8")).toBe(
      "readonly child\n",
    );

    await syncDirectoryFromSsh(input);
    expect((await readdir(localDir)).sort()).toEqual(["readonly-dir"]);
    expect(await readFile(path.join(localDir, "readonly-dir", "child.txt"), "utf8")).toBe(
      "readonly child\n",
    );
    // Leave the tree writable so temp-dir cleanup cannot litter on EACCES.
    await chmod(path.join(localDir, "readonly-dir"), 0o755).catch(() => undefined);
  });

  it("syncDirectoryFromSsh aborts a held-open transfer promptly", async () => {
    // The fake remote streams a multi-MB payload, then holds the pipe open
    // for 12s. Stop fires on the first progress line (data flowing, so tar is
    // killed with writes pending) with a 500ms fallback. Pre-fix the ssh/tar
    // children had no abort wiring, so Stop was only observed at the
    // post-transfer check when the stream ended (~12s). Post-fix the transfer
    // rejects with workspace_restore_cancelled within the bound, and the
    // pending pipe writes surface as swallowed EPIPE instead of crashing.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping transfer-abort pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    await writeFile(path.join(remoteTree, "payload.bin"), Buffer.alloc(8 * 1024 * 1024, "x"));
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(
      path.join(binDir, "ssh"),
      `#!/bin/sh\ncat ${JSON.stringify(tarball)}\nsleep 12\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error("test stop")), 500);
    try {
      const started = Date.now();
      await expect(
        syncDirectoryFromSsh({
          spec: unreachableSpec(),
          remoteDir: "/nonexistent",
          localDir,
          onProgress: () => controller.abort(new Error("test stop")),
          progressLabel: "workspace",
          signal: controller.signal,
        }),
      ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      clearTimeout(abortTimer);
    }
  }, 20000);

  it("syncDirectoryFromSsh fails fast when the extractor dies mid-transfer", async () => {
    // The fake extractor prints its failure and exits 2 without reading stdin
    // while the fake remote keeps sending a multi-MB payload, so the writes
    // to the dead extractor raise EPIPE on tar.stdin. Pre-fix the handler
    // swallowed every EPIPE, the broken pipe stopped consuming ssh output,
    // and the transfer waited for both children while the sender blocked on
    // its next write — the restore hung instead of reporting the extraction
    // failure. Post-fix the transfer rejects promptly with the extractor's
    // stderr. The extractor sleeps after printing so its stderr always
    // arrives before the pipe can break (EPIPE is impossible before exit).
    const payload = path.join(await makeTempDir("paperclip-restore-payload-"), "payload.bin");
    await writeFile(payload, Buffer.alloc(8 * 1024 * 1024, "x"));

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(
      path.join(binDir, "ssh"),
      `#!/bin/sh\ncat ${JSON.stringify(payload)}\nsleep 20\n`,
      "utf8",
    );
    await writeFile(
      path.join(binDir, "tar"),
      `#!/bin/sh\necho "fake tar: corrupt archive" >&2\nsleep 0.5\nexit 2\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "ssh"), 0o755);
    await chmod(path.join(binDir, "tar"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    const started = Date.now();
    await expect(
      syncDirectoryFromSsh({
        spec: unreachableSpec(),
        remoteDir: "/nonexistent",
        localDir,
        signal: null,
      }),
    ).rejects.toThrowError("fake tar: corrupt archive");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);

  it("syncDirectoryFromSsh yields mid-copy when Stop lands after work begins", async () => {
    // 50 remote files; the signal flips once 3 have landed in the checkout.
    // Without the per-entry copy checks all 50 land and the restore resolves.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping mid-copy pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(remoteTree, `f-${String(i).padStart(2, "0")}.txt`), `remote ${i}\n`, "utf8");
    }
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat ${JSON.stringify(tarball)}\n`, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    await writeFile(path.join(localDir, "stale.txt"), "stale\n", "utf8");
    const gated = cancelWhen(() => {
      try {
        return readdirSync(localDir).length >= 3;
      } catch {
        return false;
      }
    });

    await expect(
      syncDirectoryFromSsh({
        spec: unreachableSpec(),
        remoteDir: "/nonexistent",
        localDir,
        signal: gated,
      }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    // The stale entry was cleared before the copy began; some remote files
    // landed, and the rest were never touched.
    const copied = await readdir(localDir);
    expect(copied).not.toContain("stale.txt");
    expect(copied.length).toBeGreaterThanOrEqual(2);
    expect(copied.length).toBeLessThan(50);
  });

  it("syncDirectoryFromSsh yields mid-clear when Stop lands after work begins", async () => {
    // 50 stale files; the signal flips once 3 are gone (count <= 47).
    // Without the per-entry clear checks every stale file is deleted.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping mid-clear pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    await writeFile(path.join(remoteTree, "payload.txt"), "payload\n", "utf8");
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat ${JSON.stringify(tarball)}\n`, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(localDir, `stale-${String(i).padStart(2, "0")}.txt`), "stale\n", "utf8");
    }
    const gated = cancelWhen(() => {
      try {
        return readdirSync(localDir).length <= 47;
      } catch {
        return false;
      }
    });

    await expect(
      syncDirectoryFromSsh({
        spec: unreachableSpec(),
        remoteDir: "/nonexistent",
        localDir,
        signal: gated,
      }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    const remaining = await readdir(localDir);
    expect(remaining.length).toBeGreaterThan(40);
    expect(remaining.length).toBeLessThan(50);
    expect(remaining).not.toContain("payload.txt");
  });

  it("captureDirectorySnapshot yields mid-walk when Stop lands after work begins", async () => {
    // 100 files produce ~300 check-reads; flipping at read 60 lands mid-walk,
    // long after the 2 entry checks. Without the per-entry walk checks the
    // snapshot completes (only 2 reads ever happen) and this test fails.
    const rootDir = await makeTempDir("paperclip-snapshot-midwalk-");
    for (let i = 0; i < 100; i += 1) {
      await writeFile(path.join(rootDir, `f-${String(i).padStart(3, "0")}.txt`), `content ${i}\n`, "utf8");
    }

    await expect(
      captureDirectorySnapshot(rootDir, { exclude: [], signal: cancelAfterReads(60) }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);
  });

  it("mergeDirectoryWithBaseline yields mid-delete when Stop lands after work begins", async () => {
    // 50 remote-deleted files; the signal flips once 3 are gone. Without the
    // per-entry deletion checks every file is deleted and the merge resolves.
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(targetDir, `gone-${String(i).padStart(2, "0")}.txt`), "stale\n", "utf8");
    }
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
    const gated = cancelWhen(() => {
      try {
        return readdirSync(targetDir).length <= 47;
      } catch {
        return false;
      }
    });

    await expect(
      mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir, signal: gated }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    const remaining = await readdir(targetDir);
    expect(remaining.length).toBeGreaterThan(40);
    expect(remaining.length).toBeLessThan(50);
  });

  it("mergeDirectoryWithBaseline yields mid-copy when Stop lands after work begins", async () => {
    // The source adds 50 files to a 1-file target; the signal flips once 3
    // land. Without the per-entry copy checks all 50 land and the merge
    // resolves.
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    await writeFile(path.join(targetDir, "sentinel.txt"), "untouched\n", "utf8");
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
    await writeFile(path.join(sourceDir, "sentinel.txt"), "untouched\n", "utf8");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(sourceDir, `new-${String(i).padStart(2, "0")}.txt`), `remote ${i}\n`, "utf8");
    }
    const gated = cancelWhen(() => {
      try {
        return readdirSync(targetDir).length >= 4;
      } catch {
        return false;
      }
    });

    await expect(
      mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir, signal: gated }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    const present = await readdir(targetDir);
    expect(present).toContain("sentinel.txt");
    expect(present.length).toBeGreaterThanOrEqual(3);
    expect(present.length).toBeLessThan(51);
  });

  it("mergeDirectoryWithBaseline yields while pruning removed directories", async () => {
    // 5 removed subdirs x 10 files. Reverse path order prunes sub-05 first;
    // the signal flips once it is gone, so sub-01..sub-04 must survive. This
    // pins the prune-loop cancellation check, which the flat mid-delete case
    // never reaches.
    const sourceDir = await makeTempDir("paperclip-merge-source-");
    const targetDir = await makeTempDir("paperclip-merge-target-");
    for (let s = 1; s <= 5; s += 1) {
      const sub = path.join(targetDir, `sub-0${s}`);
      await mkdir(sub, { recursive: true });
      for (let i = 0; i < 10; i += 1) {
        await writeFile(path.join(sub, `f-${String(i).padStart(2, "0")}.txt`), "stale\n", "utf8");
      }
    }
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
    const gated = cancelWhen(() => !existsSync(path.join(targetDir, "sub-05")));

    await expect(
      mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir, signal: gated }),
    ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);

    expect(existsSync(path.join(targetDir, "sub-05"))).toBe(false);
    for (const s of ["sub-01", "sub-02", "sub-03", "sub-04"]) {
      expect((await stat(path.join(targetDir, s))).isDirectory()).toBe(true);
    }
  });

  it("syncDirectoryFromSsh returns promptly when a cancelled restore still owes its staging delete", async () => {
    // The recursive staging delete is held open behind a gate while Stop
    // lands mid-copy. Pre-fix the restore awaited the delete in `finally`,
    // so the run stayed alive for the whole-tree delete; post-fix the
    // restore rejects with workspace_restore_cancelled while the delete is
    // still pending, and the tracked background cleanup removes the staging
    // dir once the gate opens.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping staging-cleanup pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(remoteTree, `f-${String(i).padStart(2, "0")}.txt`), `remote ${i}\n`, "utf8");
    }
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat ${JSON.stringify(tarball)}\n`, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    const gated = cancelWhen(() => {
      try {
        return readdirSync(localDir).length >= 3;
      } catch {
        return false;
      }
    });

    const gatedStagingDeletes: string[] = [];
    let releaseStagingDeletes: () => void = () => {};
    const stagingDeleteGate = new Promise<void>((resolve) => {
      releaseStagingDeletes = resolve;
    });
    const realRm = fsPromises.rm;
    const rmSpy = vi.spyOn(fsPromises, "rm").mockImplementation(
      (async (...args: unknown[]) => {
        const target = args[0];
        if (gated.aborted && typeof target === "string" && target.includes("paperclip-ssh-sync-back-")) {
          gatedStagingDeletes.push(target);
          await stagingDeleteGate;
        }
        return (realRm as (...callArgs: unknown[]) => Promise<void>)(...args);
      }) as unknown as typeof fsPromises.rm,
    );

    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const restoreOutcome = syncDirectoryFromSsh({
        spec: unreachableSpec(),
        remoteDir: "/nonexistent",
        localDir,
        signal: gated,
      }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const outcome = await Promise.race([
        restoreOutcome,
        new Promise<"timed-out">((resolve) => {
          raceTimer = setTimeout(() => resolve("timed-out"), 5000);
        }),
      ]);
      expect(outcome).not.toBe("timed-out");
      expect(outcome).not.toBe("resolved");
      expect(isWorkspaceRestoreCancelled(outcome)).toBe(true);
      // The restore rejected while its staging delete was still gated.
      expect(gatedStagingDeletes).toHaveLength(1);
    } finally {
      if (raceTimer) clearTimeout(raceTimer);
      releaseStagingDeletes();
      rmSpy.mockRestore();
    }

    // The tracked background cleanup finishes the owed delete once unblocked.
    for (const target of gatedStagingDeletes) {
      await waitForPathGone(target);
    }
  }, 20000);

  it("baseline restores return promptly when a cancelled merge still owes its staging delete", async () => {
    // Baseline restores stage twice: the download staging dir is deleted when
    // the inner sync finishes, then the merge applies from the outer staging
    // dir. Stop landing mid-merge must not wait for the outer recursive
    // delete: pre-fix the outer `finally` awaited it; post-fix the restore
    // rejects while the delete is still gated, and the tracked background
    // cleanup removes the staging dir once the gate opens.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("tar", ["--version"]);
    } catch {
      console.warn("Skipping baseline staging-cleanup pin: tar is not available");
      return;
    }

    const remoteTree = await makeTempDir("paperclip-restore-remote-");
    await writeFile(path.join(remoteTree, "sentinel.txt"), "untouched\n", "utf8");
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(remoteTree, `new-${String(i).padStart(2, "0")}.txt`), `remote ${i}\n`, "utf8");
    }
    const tarball = path.join(await makeTempDir("paperclip-restore-tarball-"), "remote.tar");
    await execFileAsync("tar", ["-cf", tarball, "-C", remoteTree, "."]);

    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat ${JSON.stringify(tarball)}\n`, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const localDir = await makeTempDir("paperclip-restore-live-");
    await writeFile(path.join(localDir, "sentinel.txt"), "untouched\n", "utf8");
    const baseline = await captureDirectorySnapshot(localDir, { exclude: [] });
    const gated = cancelWhen(() => {
      try {
        return readdirSync(localDir).length >= 4;
      } catch {
        return false;
      }
    });

    const gatedStagingDeletes: string[] = [];
    let releaseStagingDeletes: () => void = () => {};
    const stagingDeleteGate = new Promise<void>((resolve) => {
      releaseStagingDeletes = resolve;
    });
    const realRm = fsPromises.rm;
    const rmSpy = vi.spyOn(fsPromises, "rm").mockImplementation(
      (async (...args: unknown[]) => {
        const target = args[0];
        // Only post-cancellation deletes are gated: the inner download
        // staging delete runs before the merge flips the signal, so it must
        // pass through untouched.
        if (gated.aborted && typeof target === "string" && target.includes("paperclip-ssh-sync-back-")) {
          gatedStagingDeletes.push(target);
          await stagingDeleteGate;
        }
        return (realRm as (...callArgs: unknown[]) => Promise<void>)(...args);
      }) as unknown as typeof fsPromises.rm,
    );

    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const restoreOutcome = restoreWorkspaceFromSshExecution({
        spec: unreachableSpec(),
        localDir,
        baselineSnapshot: baseline,
        signal: gated,
      }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const outcome = await Promise.race([
        restoreOutcome,
        new Promise<"timed-out">((resolve) => {
          raceTimer = setTimeout(() => resolve("timed-out"), 5000);
        }),
      ]);
      expect(outcome).not.toBe("timed-out");
      expect(outcome).not.toBe("resolved");
      expect(isWorkspaceRestoreCancelled(outcome)).toBe(true);
      // Only the outer staging delete was still owed at cancellation time.
      expect(gatedStagingDeletes).toHaveLength(1);
    } finally {
      if (raceTimer) clearTimeout(raceTimer);
      releaseStagingDeletes();
      rmSpy.mockRestore();
    }

    for (const target of gatedStagingDeletes) {
      await waitForPathGone(target);
    }
  }, 20000);

  it("mergeDirectoryWithBaseline yields promptly when Stop lands while waiting for a contended merge lock", async () => {
    // Merge A holds the target's directory merge lock inside beforeApply
    // (the incident topology: a contended shared checkout). Merge B starts
    // against the same target with a live signal; Stop lands while B waits
    // for the lock. Pre-fix the lock wait polled for the full 30s budget
    // with no signal check, so B stayed running and then failed with
    // ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT, misclassifying an operator stop
    // as lock contention. Post-fix B yields promptly with
    // workspace_restore_cancelled and A still completes.
    const sourceDir = await makeTempDir("paperclip-merge-lock-source-");
    const targetDir = await makeTempDir("paperclip-merge-lock-target-");
    await writeFile(path.join(sourceDir, "remote-edit.txt"), "from remote\n", "utf8");
    await writeFile(path.join(targetDir, "sentinel.txt"), "untouched\n", "utf8");
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    let releaseA!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseA = resolve; });
    let aHoldsLock!: () => void;
    const holdsLockGate = new Promise<void>((resolve) => { aHoldsLock = resolve; });
    const mergeA = mergeDirectoryWithBaseline({
      baseline,
      sourceDir,
      targetDir,
      beforeApply: async () => {
        aHoldsLock();
        await releaseGate;
      },
    });
    await holdsLockGate;

    const controllerB = new AbortController();
    const mergeB = mergeDirectoryWithBaseline({
      baseline,
      sourceDir,
      targetDir,
      signal: controllerB.signal,
    });
    // B's tiny source capture finishes in milliseconds; after this sleep B
    // is necessarily spinning in the lock wait (A holds the lock, the wait
    // budget is 30s). Abort then lands mid-wait, past every pre-lock check.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    controllerB.abort(new Error("test stop"));
    const started = Date.now();
    await expect(mergeB).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);
    expect(Date.now() - started).toBeLessThan(8000);
    releaseA();
    await mergeA;
    expect(await readFile(path.join(targetDir, "remote-edit.txt"), "utf8")).toBe("from remote\n");
  }, 45000);

  it("restoreWorkspaceFromSshExecution aborts a held-open git-bundle transfer promptly", async () => {
    // Git-backed workspaces run the bundle export first on every restore.
    // The fake remote streams a multi-MB payload, then holds the pipe open
    // for 12s. Stop fires on the first progress line with a 500ms
    // fallback. The restore must reject with workspace_restore_cancelled
    // within the bound, and the local fetch/reset must never apply (HEAD
    // unchanged, no imported ref). Reverting the `signal` wiring on the
    // bundle stream leaves this red: the abort is then only observed at the
    // post-stream checkpoint after the full 12s hold (~12s, over the bound)
    // instead of interrupting the transfer.
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      console.warn("Skipping bundle-abort pin: git is not available");
      return;
    }

    const localRepo = await makeTempDir("paperclip-restore-git-local-");
    await execFileAsync("git", ["-C", localRepo, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", localRepo, "config", "user.name", "Paperclip Test"]);
    await execFileAsync("git", ["-C", localRepo, "config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await execFileAsync("git", ["-C", localRepo, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", localRepo, "commit", "-m", "initial"]);
    const { stdout: headBefore } = await execFileAsync("git", ["-C", localRepo, "rev-parse", "HEAD"]);
    const baseline = await captureDirectorySnapshot(localRepo, { exclude: [] });

    const payload = path.join(await makeTempDir("paperclip-restore-bundle-"), "payload.bin");
    await writeFile(payload, Buffer.alloc(8 * 1024 * 1024, "x"));
    const binDir = await makeTempDir("paperclip-fake-ssh-bin-");
    await writeFile(
      path.join(binDir, "ssh"),
      `#!/bin/sh\ncat ${JSON.stringify(payload)}\nsleep 12\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "ssh"), 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error("test stop")), 500);
    try {
      const started = Date.now();
      await expect(
        restoreWorkspaceFromSshExecution({
          spec: unreachableSpec(),
          localDir: localRepo,
          remoteDir: "/nonexistent",
          baselineSnapshot: baseline,
          restoreGitHistory: true,
          onProgress: () => controller.abort(new Error("test stop")),
          signal: controller.signal,
        }),
      ).rejects.toThrowError(WORKSPACE_RESTORE_CANCELLED);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      clearTimeout(abortTimer);
    }

    const { stdout: headAfter } = await execFileAsync("git", ["-C", localRepo, "rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);
    const { stdout: importedRefs } = await execFileAsync("git", [
      "-C", localRepo, "for-each-ref", "refs/paperclip/ssh-sync/imported",
    ]);
    expect(importedRefs.trim()).toBe("");
  }, 20000);
});
