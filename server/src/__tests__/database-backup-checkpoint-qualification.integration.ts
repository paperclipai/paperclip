import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, runDatabaseBackup, runDatabaseRestore } from "@paperclipai/db";
import { createDatabaseBackupOwner } from "../services/database-backup-owner.js";
import { idleBackupWakeMarker, verifyIdleDatabaseBackup } from "../services/idle-database-backup.js";
import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { assertDistinctEmptyRestore, inspectRestoredFixture, qualifyBackupRestore, resolveBackupQualificationPair, retention, seedBackupQualificationFixture } from "../../scripts/lib/backup-qualification.js";

const configuredPair = resolveBackupQualificationPair();
if (!configuredPair) throw new Error("Backup qualification requires an explicit dedicated source/restore test URL pair");
const pair = configuredPair;
describe("real automatic backup checkpoint qualification", () => {
  let directory: string;
  let source: ReturnType<typeof createDb>;
  let ownsRestoreFixture = false;
  const logger = { info() {}, warn() {}, error() {} };
  const receipts: unknown[] = [];
  const owner = () => createDatabaseBackupOwner({ connectionString: pair.sourceUrl, backupDir: directory, getRetention: async () => retention, logger });
  beforeAll(async () => {
    const receiptFile = process.env.PAPERCLIP_BACKUP_QUALIFICATION_RECEIPT;
    const parent = receiptFile ? path.dirname(receiptFile) : os.tmpdir();
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(path.join(parent, "backup-checkpoint-qualification-"));
    source = createDb(pair.sourceUrl, { maxConnections: 1 });
    await assertDistinctEmptyRestore(pair);
    ownsRestoreFixture = true;
    await seedBackupQualificationFixture(pair.sourceUrl);
    const [column] = await source.$client`SELECT data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'backup_qualification' AND table_name = 'binary_arrays' AND column_name = 'payloads'`;
    expect(column).toEqual({ data_type: "ARRAY", udt_name: "_bytea" });
    const [driver] = await source.$client`SELECT payloads FROM backup_qualification.binary_arrays WHERE id = 4`;
    expect(Array.isArray(driver!.payloads[0])).toBe(true);
    expect(Buffer.isBuffer(driver!.payloads[0][0])).toBe(true);
    const [sqlNull] = await source.$client`SELECT payloads[1][2] IS NULL AS is_null
      FROM backup_qualification.binary_arrays WHERE id = 4`;
    expect(sqlNull?.is_null).toBe(true);
    receipts.push({ case: "binary-array-driver-representation", column, nestedBuffers: true,
      sqlNullElement: true, parsedNullElement: driver!.payloads[0][1] === null ? "null"
        : Buffer.isBuffer(driver!.payloads[0][1]) ? "Buffer" : typeof driver!.payloads[0][1] });
  }, 120_000);
  afterAll(async () => {
    try {
      const receiptFile = process.env.PAPERCLIP_BACKUP_QUALIFICATION_RECEIPT;
      if (receiptFile) await writeFile(receiptFile, JSON.stringify({ version: 1, cases: receipts, directory,
        sourceDatabase: new URL(pair.sourceUrl).pathname.slice(1), restoreDatabase: new URL(pair.restoreUrl).pathname.slice(1) }, null, 2));
    } finally {
      try { if (ownsRestoreFixture) await emptyRestore(); }
      finally { await source?.$client.end({ timeout: 5 }); }
      if (directory && !process.env.PAPERCLIP_BACKUP_QUALIFICATION_RECEIPT) await rm(directory, { recursive: true, force: true });
    }
  });
  async function emptyRestore() {
    const target = createDb(pair.restoreUrl, { maxConnections: 1 }).$client;
    try {
      const tables = await target`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`;
      for (const { nspname, relname } of tables) await target`DROP TABLE IF EXISTS ${target(nspname)}.${target(relname)} CASCADE`;
      const schemas = await target`SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('information_schema') AND nspname !~ '^pg_'`;
      for (const { nspname } of schemas) await target`DROP SCHEMA ${target(nspname)} CASCADE`;
      await target`CREATE SCHEMA public`;
    } finally { await target.end({ timeout: 5 }); }
  }
  it("rejects the same actual database behind a hostname alias and nonempty targets", async () => {
    const alias = new URL(pair.sourceUrl); alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await expect(assertDistinctEmptyRestore({ ...pair, restoreUrl: alias.toString() })).rejects.toThrow("same actual database");
    const target = createDb(pair.restoreUrl, { maxConnections: 1 }).$client;
    try {
      for (const [create, drop] of [
        ["CREATE TABLE guard_fixture (id integer)", "DROP TABLE guard_fixture"],
        ["CREATE TYPE guard_fixture AS ENUM ('retained')", "DROP TYPE guard_fixture"],
        ["CREATE FUNCTION guard_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION guard_fixture()"],
      ]) {
        await target.unsafe(create!);
        try { await expect(assertDistinctEmptyRestore(pair)).rejects.toThrow("must be empty"); }
        finally { await target.unsafe(drop!); }
      }
    } finally { await target.end({ timeout: 5 }); }
  });

  it.each(["pg_dump", "javascript"] as const)("restores the real %s archive with relationships, values and sequence progress", async engine => {
    if (engine === "javascript") await emptyRestore();
    const versions = Object.fromEntries([process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump", process.env.PAPERCLIP_PSQL_PATH || "psql"]
      .map(binary => [binary, execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()]));
    const result = await qualifyBackupRestore(pair, directory, engine);
    expect(result.restored).toEqual({ relational: true, unicode: true, binary: true, emptyBinary: true, nullBinary: true, binaryArrays: true, nestedBinaryArrays: true, binaryArrayBounds: true, nullable: true, nextIdentity: "2", foreignKeyEnforced: true });
    expect(gunzipSync(await readFile(result.archive)).length).toBeGreaterThan(0);
    receipts.push({ ...result, versions });
  }, 120_000);

  it("restores the real JavaScript fallback after pg_dump is unavailable", async () => {
    await emptyRestore();
    const previous = process.env.PAPERCLIP_PG_DUMP_PATH;
    process.env.PAPERCLIP_PG_DUMP_PATH = path.join(directory, "missing-pg-dump");
    try {
      const result = await qualifyBackupRestore(pair, directory, "auto");
      expect(result.restored.foreignKeyEnforced).toBe(true);
      receipts.push({ ...result, case: "automatic-javascript-fallback", pgDumpUnavailable: true });
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH; else process.env.PAPERCLIP_PG_DUMP_PATH = previous;
    }
  }, 120_000);

  it("permits sleep only after the production owner finishes a real checkpoint and restores its just-committed state", async () => {
    await emptyRestore();
    const clock = Date.now();
    const hold: IdleSleepDrainStatus = { ownerId: "checkpoint-owner", draining: true, startedAt: new Date(clock - 1), expiresAt: new Date(clock + 120_000), activeRuns: 0, pendingWakes: 0 };
    const run = owner(); let archive: string | undefined;
    expect(await readIdleSleepSafety(source, () => hold, () => Date.now(), hold.ownerId, async () => "none", undefined,
      async () => { const result = await run("idle"); archive = result!.backupFile; return Boolean(result); }))
      .toEqual({ version: 1, backgroundWork: "none" });
    expect(idleWorkSnapshot().active).toBe(0);
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    await assertDistinctEmptyRestore(pair);
    await runDatabaseRestore({ connectionString: pair.restoreUrl, backupFile: archive! });
    expect((await inspectRestoredFixture(pair.restoreUrl)).nextIdentity).toBe("2");
    receipts.push({ case: "real-owner-safety-and-restore", archive, markerRetained: true });
  }, 120_000);

  it.each(["expiry", "owner", "generation"])("keeps a slow real dump active and fences a changed %s", async change => {
    let clock = Date.now();
    let hold: IdleSleepDrainStatus = { ownerId: "slow-owner", draining: true, startedAt: new Date(clock - 1), expiresAt: new Date(clock + 120_000), activeRuns: 0, pendingWakes: 0 };
    const barrier = path.join(directory, `slow-${change}.ready`), release = path.join(directory, `slow-${change}.release`);
    const wrapper = path.join(directory, `slow-${change}.mjs`);
    const previous = process.env.PAPERCLIP_PG_DUMP_PATH;
    await writeFile(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { existsSync, writeFileSync } from 'node:fs';\nconst result = spawnSync(${JSON.stringify(previous || "pg_dump")}, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });\nif (result.status !== 0) process.exit(result.status ?? 1);\nwriteFileSync(${JSON.stringify(barrier)}, 'streamed');\nsetInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);\n`);
    await chmod(wrapper, 0o700); process.env.PAPERCLIP_PG_DUMP_PATH = wrapper;
    const run = owner();
    const safety = readIdleSleepSafety(source, () => hold, () => clock, "slow-owner", async () => "none", undefined, async () => Boolean(await run("idle")));
    let result;
    try {
      await vi.waitFor(() => expect(existsSync(barrier)).toBe(true), { timeout: 60_000 });
      expect(idleWorkSnapshot().active).toBe(1);
      expect(await run("scheduled")).toBeNull();
      if (change === "expiry") clock += 120_000;
      if (change === "owner") hold = { ...hold, ownerId: "replacement" };
      if (change === "generation") beginIdleTrackedWork()();
      expect(idleWorkSnapshot().active).toBe(1);
    } finally {
      await writeFile(release, "release owned dump");
      if (previous === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH; else process.env.PAPERCLIP_PG_DUMP_PATH = previous;
      result = await safety;
    }
    expect(result).toEqual({ version: 1, backgroundWork: "unknown" });
    expect(idleWorkSnapshot().active).toBe(0);
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    receipts.push({ case: `slow-real-dump-${change}`, activeUntilSettled: true, sleepRefused: true });
  }, 120_000);

  it.each(["auto", "javascript"] as const)("preserves prior recovery points after %s verification failure without fallback or pruning", async engine => {
    const first = await owner()("idle"); const firstBytes = await readFile(first!.backupFile);
    const history = path.join(directory, "paperclip-history.sql.gz"); const historyBytes = gzipSync("SELECT 'history';");
    await writeFile(history, historyBytes); await utimes(history, new Date(0), new Date(0));
    const failure = new Error("qualification fsync boundary failed"); let verifications = 0;
    await expect(runDatabaseBackup({ connectionString: pair.sourceUrl, backupDir: directory, retention, backupEngine: engine,
      verifyBeforePrune: async archive => { verifications++; await verifyIdleDatabaseBackup(archive); throw failure; } })).rejects.toBe(failure);
    expect(verifications).toBe(1);
    expect(await readFile(first!.backupFile)).toEqual(firstBytes);
    expect(await readFile(history)).toEqual(historyBytes);
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    receipts.push({ case: "verification-failure", previousArchive: first!.backupFile, previousArchiveRetained: true, engine, verificationCalls: verifications });
  }, 120_000);

  it("retains an interrupted checkpoint, refuses a failed wake backup, then recovers through the same production owner", async () => {
    const first = await owner()("idle"); const firstBytes = await readFile(first!.backupFile);
    const barrier = path.join(directory, "dump-streamed");
    const wrapper = path.join(directory, "slow-pg-dump.mjs");
    const realPgDump = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
    await writeFile(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst result = spawnSync(${JSON.stringify(realPgDump)}, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });\nif (result.status !== 0) process.exit(result.status ?? 1);\nwriteFileSync(${JSON.stringify(barrier)}, 'real pg_dump exited; pipeline remains open');\nsetInterval(() => {}, 1000);\n`);
    await chmod(wrapper, 0o700);
    const worker = fileURLToPath(new URL("./fixtures/database-backup-worker.ts", import.meta.url));
    const tsx = fileURLToPath(import.meta.resolve("tsx"));
    const child = spawn(process.execPath, ["--import", tsx, worker], { detached: true, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PAPERCLIP_PG_DUMP_PATH: wrapper, PAPERCLIP_BACKUP_WORKER_DATABASE_URL: pair.sourceUrl, PAPERCLIP_BACKUP_WORKER_DIRECTORY: directory } });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try {
      await vi.waitFor(() => { if (child.exitCode !== null) throw new Error(`Owned worker exited: ${stderr}`); expect(existsSync(barrier)).toBe(true); }, { timeout: 60_000 });
      expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await exited;
    }
    expect(await readFile(first!.backupFile)).toEqual(firstBytes);
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    const unavailable = new URL(pair.sourceUrl); unavailable.port = "1";
    await expect(createDatabaseBackupOwner({ connectionString: unavailable.toString(), backupDir: directory, getRetention: async () => retention, logger })("scheduled")).rejects.toThrow();
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    await owner()("scheduled");
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(false);
    expect(await readFile(first!.backupFile)).toEqual(firstBytes);
    receipts.push({ case: "owned-child-interruption-wake-recovery", markerSurvived: true, priorArchiveRetained: true, wakeBackupVerified: true });
  }, 120_000);
});
