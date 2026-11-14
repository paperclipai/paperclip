import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { assertDistinctEmptyRestore, qualifyBackupRestore, resolveBackupQualificationPair } from "../../scripts/lib/backup-qualification.js";

const configuredPair = resolveBackupQualificationPair();
if (!configuredPair) throw new Error("Backup guard qualification requires an explicit dedicated source/restore test URL pair");
const pair = configuredPair;

describe("backup restore schema guard", () => {
  it("refuses a populated pgdata schema without backup or restore and preserves its rows", async () => {
    const target = createDb(pair.restoreUrl, { maxConnections: 1 }).$client;
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-restore-guard-"));
    let createdSchema = false;
    try {
      await assertDistinctEmptyRestore(pair);
      await target`CREATE SCHEMA pgdata`;
      createdSchema = true;
      await target`CREATE TABLE pgdata.retained (id integer PRIMARY KEY, value text NOT NULL)`;
      await target`INSERT INTO pgdata.retained VALUES (1, 'keep this existing target data')`;
      const guardFailure = await assertDistinctEmptyRestore(pair).then(() => undefined, error => error);
      expect(await target`SELECT id, value FROM pgdata.retained`).toEqual([{ id: 1, value: "keep this existing target data" }]);
      expect(await readdir(directory)).toEqual([]);
      expect(guardFailure).toBeInstanceOf(Error);
      expect(guardFailure.message).toBe("Backup restore target must be empty before restore");
      await expect(qualifyBackupRestore(pair, directory, "pg_dump")).rejects.toThrow("Backup restore target must be empty before restore");
      expect(await target`SELECT id, value FROM pgdata.retained`).toEqual([{ id: 1, value: "keep this existing target data" }]);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      try { if (createdSchema) await target`DROP SCHEMA pgdata CASCADE`; }
      finally { await target.end({ timeout: 5 }); await rm(directory, { recursive: true, force: true }); }
    }
  });
});
