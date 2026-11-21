import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Device map for the root-filesystem guard: "/" always reports device 1.
// A path ending in "on-backup-volume" reports device 2 (a mounted backup
// volume); everything else shares device 1 with the root filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fakeStatSync = ((path: string) => {
    if (String(path) === "/") return { dev: 1 };
    if (String(path).endsWith("on-backup-volume")) return { dev: 2 };
    return { dev: 1 };
  }) as unknown as typeof import("node:fs").statSync;
  return {
    ...actual,
    statSync: fakeStatSync,
  };
});

import { runDatabaseBackup } from "./backup-lib.js";

const RETENTION = { dailyDays: 3, weeklyWeeks: 4, monthlyMonths: 1 };
const UNREACHABLE_DB = "postgres://invalid.invalid:5432/nope";

function makeRoot(name: string): string {
  const root = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

it("refuses to run when backupDir sits on the root filesystem", async () => {
  const root = makeRoot("pc-guard-refuse");
  try {
    const backupDir = join(root, "disk", "backups");
    mkdirSync(backupDir, { recursive: true });
    await expect(
      runDatabaseBackup({
        connectionString: UNREACHABLE_DB,
        backupDir,
        retention: RETENTION,
        requireMountedBackupDir: true,
      }),
    ).rejects.toThrow(/missing or on the root filesystem/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not create a missing backupDir when the guard is enabled (fails closed)", async () => {
  const root = makeRoot("pc-guard-nomkdir");
  try {
    const backupDir = join(root, "disk", "not-created-yet");
    await expect(
      runDatabaseBackup({
        connectionString: UNREACHABLE_DB,
        backupDir,
        retention: RETENTION,
        requireMountedBackupDir: true,
      }),
    ).rejects.toThrow(/missing or on the root filesystem/);
    expect(existsSync(backupDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("proceeds past the guard when backupDir is on a different device from /", async () => {
  const root = makeRoot("pc-guard-ok");
  try {
    const backupDir = join(root, "disk", "backups-on-backup-volume");
    mkdirSync(backupDir, { recursive: true });
    // Guard passes (device 2 vs root device 1) => the run continues; the
    // unreachable connection string fails later, NOT with the guard error.
    await expect(
      runDatabaseBackup({
        connectionString: UNREACHABLE_DB,
        backupDir,
        retention: RETENTION,
        requireMountedBackupDir: true,
      }),
    ).rejects.toThrow(/getaddrinfo|connection|connect|fetch failed|ECONNREFUSED/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps legacy permissive behavior when the guard is unset", async () => {
  const root = makeRoot("pc-guard-legacy");
  try {
    const backupDir = join(root, "disk", "legacy-mkdir");
    await expect(
      runDatabaseBackup({
        connectionString: UNREACHABLE_DB,
        backupDir,
        retention: RETENTION,
      }),
    ).rejects.toThrow(/getaddrinfo|connection|connect|fetch failed|ECONNREFUSED/i);
    expect(existsSync(backupDir)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
