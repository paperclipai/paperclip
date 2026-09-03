import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSshSyncBackDiskHeadroom, reapStaleSshTempDirs } from "./ssh.js";

describe("reapStaleSshTempDirs", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function ageDir(dirPath: string, ageMs: number): Promise<void> {
    const past = new Date(Date.now() - ageMs);
    await utimes(dirPath, past, past);
  }

  it("removes stale sync-back and bundle staging dirs older than the max age", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tmp-cleanup-test-"));
    cleanupDirs.push(tmpRoot);

    const staleSyncBack = path.join(tmpRoot, "paperclip-ssh-sync-back-abc123");
    const staleBundle = path.join(tmpRoot, "paperclip-ssh-bundle-def456");
    await mkdir(staleSyncBack, { recursive: true });
    await mkdir(staleBundle, { recursive: true });
    await writeFile(path.join(staleSyncBack, "node_modules-marker.bin"), "x");
    await ageDir(staleSyncBack, 2 * 60 * 60 * 1000);
    await ageDir(staleBundle, 2 * 60 * 60 * 1000);

    await reapStaleSshTempDirs({ tmpRoot, maxAgeMs: 60 * 60 * 1000 });

    await expect(stat(staleSyncBack)).rejects.toThrow();
    await expect(stat(staleBundle)).rejects.toThrow();
  });

  it("leaves fresh staging dirs from an in-flight sync-back untouched", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tmp-cleanup-test-"));
    cleanupDirs.push(tmpRoot);

    const freshDir = path.join(tmpRoot, "paperclip-ssh-sync-back-fresh1");
    await mkdir(freshDir, { recursive: true });

    await reapStaleSshTempDirs({ tmpRoot, maxAgeMs: 60 * 60 * 1000 });

    await expect(stat(freshDir)).resolves.toBeDefined();
  });

  it("ignores directories that don't match a known sync-back/bundle prefix", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tmp-cleanup-test-"));
    cleanupDirs.push(tmpRoot);

    const unrelatedDir = path.join(tmpRoot, "some-other-tool-staging-xyz");
    await mkdir(unrelatedDir, { recursive: true });
    await ageDir(unrelatedDir, 2 * 60 * 60 * 1000);

    await reapStaleSshTempDirs({ tmpRoot, maxAgeMs: 60 * 60 * 1000 });

    await expect(stat(unrelatedDir)).resolves.toBeDefined();
  });
});

describe("ensureSshSyncBackDiskHeadroom", () => {
  it("resolves when free space is above the configured floor", async () => {
    await expect(
      ensureSshSyncBackDiskHeadroom({ targetDir: os.tmpdir(), minFreeBytes: 1 }),
    ).resolves.toBeUndefined();
  });

  it("throws a clear error when free space is below the configured floor", async () => {
    await expect(
      ensureSshSyncBackDiskHeadroom({
        targetDir: os.tmpdir(),
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/Insufficient disk space/);
  });
});
