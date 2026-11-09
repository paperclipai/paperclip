import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "../services/idle-database-backup.js";

const syncs = vi.hoisted(() => ({ events: [] as string[], fail: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const name = (await handle.stat()).isDirectory() ? "directory" : path.basename(String(args[0]));
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      syncs.events.push(name);
      if (syncs.fail === name) throw new Error(`injected ${name} fsync failure`);
      await sync();
    };
    return handle;
  } };
});
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "backup-sync-")); syncs.events = []; syncs.fail = ""; });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
describe("idle checkpoint persistence barriers", () => {
  it("syncs the marker, archive and directory entries before reporting completion", async () => {
    await markIdleBackupWakeRequired(directory);
    expect(syncs.events).toEqual([".idle-backup-wake-required", "directory"]);
    const archive = path.join(directory, "checkpoint.sql.gz"); await writeFile(archive, gzipSync("SELECT 1;"));
    await verifyIdleDatabaseBackup(archive);
    expect(syncs.events.slice(-2)).toEqual(["checkpoint.sql.gz", "directory"]);
    await clearIdleBackupWakeRequired(directory);
    expect(syncs.events.at(-1)).toBe("directory");
    await expect(readFile(idleBackupWakeMarker(directory))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["checkpoint.sql.gz", "directory"])("rejects %s fsync failure and retains the wake obligation", async boundary => {
    await markIdleBackupWakeRequired(directory);
    const archive = path.join(directory, "checkpoint.sql.gz"); await writeFile(archive, gzipSync("SELECT 1;"));
    syncs.fail = boundary;
    await expect(verifyIdleDatabaseBackup(archive)).rejects.toThrow(`injected ${boundary} fsync failure`);
    expect(await readFile(idleBackupWakeMarker(directory), "utf8")).toContain("restarts");
  });
  it.each([".idle-backup-wake-required", "directory"])("rejects marker %s fsync failure", async boundary => {
    syncs.fail = boundary;
    await expect(markIdleBackupWakeRequired(directory)).rejects.toThrow(`injected ${boundary} fsync failure`);
  });
});
