import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { captureDirectorySnapshot, disposeDirectorySnapshot, type DirectorySnapshot } from "./workspace-restore-merge.js";
import { writeCheckpointBaseline, workspaceCheckpointScript, readCheckpointSnapshot, validateCheckpointPayload } from "./workspace-checkpoint.js";

const execute = promisify(execFile);
const roots: string[] = [];
const snapshots: DirectorySnapshot[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(snapshots.splice(0).map(disposeDirectorySnapshot));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(failure: "none" | "read" | "mutation" | "full_db" | "walk") {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-capture-"));
  roots.push(temp);
  vi.stubEnv("PAPERCLIP_HOME", path.join(temp, "home"));
  const root = path.join(temp, "root");
  await fs.mkdir(root);
  for (let index = 0; index < 32; index++) {
    await fs.writeFile(path.join(root, `${failure === "full_db" ? "x".repeat(200) : ""}file-${String(index).padStart(2, "0")}`), Buffer.alloc(64 * 1024, index));
  }
  const baseline = await captureDirectorySnapshot(root, { diskBacked: true, exclude: [] });
  snapshots.push(baseline);
  const manifest = path.join(temp, "baseline.sqlite");
  await writeCheckpointBaseline(baseline, manifest);
  const script = path.join(temp, "checkpoint.mjs");
  await fs.writeFile(script, workspaceCheckpointScript());
  const tracker = path.join(temp, "tracker.mjs");
  await fs.writeFile(tracker, `
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const original = fs.createReadStream;
const originalClose = DatabaseSync.prototype.close;
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalLstat = fs.promises.lstat;
let heldPath;
const stats = { opened: 0, closed: 0, active: 0, peak: 0, sqliteFull: 0, databaseCloseActive: [] };
DatabaseSync.prototype.close = function() { stats.databaseCloseActive.push(stats.active); return originalClose.call(this); };
DatabaseSync.prototype.exec = function(sql) {
  return originalExec.call(this, process.env.CHECKPOINT_FIXTURE_FAILURE === 'full_db' && sql.startsWith('PRAGMA max_page_count=') ? 'PRAGMA max_page_count=2' : sql);
};
DatabaseSync.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (sql.startsWith('INSERT INTO records')) {
    const originalRun = statement.run;
    statement.run = function(...args) {
      try { return originalRun.apply(this, args); }
      catch (error) { if (error.message.includes('database or disk is full')) stats.sqliteFull++; throw error; }
    };
  }
  return statement;
};
fs.promises.lstat = async function(file, ...args) {
  if (process.env.CHECKPOINT_FIXTURE_FAILURE === 'walk' && stats.opened > 0 && String(file) !== heldPath) throw new Error('fixture-checkpoint-walk-failure');
  return originalLstat.call(this, file, ...args);
};
fs.createReadStream = function(file, options) {
  let waiting = false;
  const victim = path.basename(String(file)) === 'file-00';
  let stream = process.env.CHECKPOINT_FIXTURE_FAILURE === 'read' && victim
    ? new Readable({ read() { if (!waiting) { waiting = true; setTimeout(() => this.destroy(new Error('fixture-checkpoint-read-failure')), 20); } } })
    : original.call(this, file, options);
  const holdForWalk = process.env.CHECKPOINT_FIXTURE_FAILURE === 'walk' && stats.opened === 0;
  if (holdForWalk) heldPath = String(file);
  if (holdForWalk || (process.env.CHECKPOINT_FIXTURE_FAILURE === 'full_db' && String(file).endsWith('file-15'))) {
    const source = stream;
    stream = Readable.from((async function*() { await new Promise(resolve => setTimeout(resolve, 50)); yield* source; })());
  }
  if (process.env.CHECKPOINT_FIXTURE_FAILURE === 'mutation' && victim) stream.once('data', () => fs.appendFileSync(file, '!'));
  stats.opened++; stats.active++; stats.peak = Math.max(stats.peak, stats.active);
  stream.once('close', () => { stats.closed++; stats.active--; });
  return stream;
};
syncBuiltinESMExports();
process.once('exit', () => fs.writeFileSync(process.env.CHECKPOINT_FIXTURE_STATS, JSON.stringify(stats)));
`);
  const output = path.join(temp, "output");
  const statsPath = path.join(temp, "stats.json");
  const run = () => execute(process.execPath, ["--import", tracker, script, root, manifest, output, "[]"], {
    timeout: 10_000,
    env: { ...process.env, CHECKPOINT_FIXTURE_FAILURE: failure, CHECKPOINT_FIXTURE_STATS: statsPath },
  });
  return { root, baseline, run, output, stats: async () => JSON.parse(await fs.readFile(statsPath, "utf8")) as { opened: number; closed: number; active: number; peak: number; sqliteFull: number; databaseCloseActive: number[] } };
}

it("bounds concurrent file readers and retains an unchanged checkpoint", async () => {
  const f = await fixture("none");
  await f.run();
  const stats = await f.stats();
  expect(stats.peak).toBeGreaterThan(1);
  expect(stats.peak).toBeLessThanOrEqual(8);
  expect(stats.active).toBe(0);
  expect(stats.closed).toBe(stats.opened);
  const snapshot = readCheckpointSnapshot(path.join(f.output, "manifest.sqlite"), f.baseline);
  snapshots.push(snapshot);
  expect(await validateCheckpointPayload({ baseline: f.baseline, snapshot, payload: path.join(f.output, "payload") }))
    .toMatchObject({ changedFiles: 0, payloadBytes: 0, scannedEntries: 32 });
});

it("captures every changed file across bounded batches with valid directory parents and modes", async () => {
  const f = await fixture("none");
  for (let index = 0; index < 32; index++) {
    await fs.writeFile(path.join(f.root, `file-${String(index).padStart(2, "0")}`), Buffer.alloc(64 * 1024, index + 1));
  }
  await fs.chmod(path.join(f.root, "file-00"), 0o755);
  await fs.mkdir(path.join(f.root, "nested", "inner"), { recursive: true });
  await fs.writeFile(path.join(f.root, "nested", "inner", "new"), "new content");
  await fs.symlink("nested/inner/new", path.join(f.root, "link"));
  await f.run();
  const snapshot = readCheckpointSnapshot(path.join(f.output, "manifest.sqlite"), f.baseline);
  snapshots.push(snapshot);
  const payload = path.join(f.output, "payload");
  expect(await validateCheckpointPayload({ baseline: f.baseline, snapshot, payload }))
    .toMatchObject({ changedFiles: 33, payloadBytes: 32 * 64 * 1024 + 11, scannedEntries: 36 });
  for (let index = 0; index < 32; index++) {
    expect((await fs.readFile(path.join(payload, `file-${String(index).padStart(2, "0")}`)))
      .equals(Buffer.alloc(64 * 1024, index + 1))).toBe(true);
  }
  expect((await fs.stat(path.join(payload, "file-00"))).mode & 0o777).toBe(0o755);
  expect(await fs.readlink(path.join(payload, "link"))).toBe("nested/inner/new");
  const stats = await f.stats();
  expect(stats.peak).toBeLessThanOrEqual(8);
  expect(stats.active).toBe(0);
  expect(stats.closed).toBe(stats.opened);
});

it.each(["read", "mutation"] as const)("settles readers and publishes no receipt after a %s failure", async failure => {
  const f = await fixture(failure);
  await expect(f.run()).rejects.toThrow(failure === "read" ? "fixture-checkpoint-read-failure" : "Workspace changed during checkpoint capture");
  const stats = await f.stats();
  expect(stats.opened).toBeGreaterThan(1);
  expect(stats.active).toBe(0);
  expect(stats.closed).toBe(stats.opened);
  await expect(fs.stat(path.join(f.output, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const db = new DatabaseSync(path.join(f.output, "manifest.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT count(*) AS count FROM records").get()!.count).toBe(0); }
  finally { db.close(); }
});

it("does not commit later captures after SQLite automatically rolls back a full manifest", async () => {
  const f = await fixture("full_db");
  await expect(f.run()).rejects.toThrow(/database or disk is full|transaction ended during capture/);
  await expect(fs.stat(path.join(f.output, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const db = new DatabaseSync(path.join(f.output, "manifest.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT count(*) AS count FROM records").get()!.count).toBe(0); }
  finally { db.close(); }
  const stats = await f.stats();
  expect(stats.sqliteFull).toBeGreaterThan(0);
  expect(stats.active).toBe(0);
  expect(stats.databaseCloseActive).toEqual([0, 0]);
});

it("drains active readers before closing either database after a walk failure", async () => {
  const f = await fixture("walk");
  await expect(f.run()).rejects.toThrow("fixture-checkpoint-walk-failure");
  const stats = await f.stats();
  expect(stats.opened).toBeGreaterThan(0);
  expect(stats.active).toBe(0);
  expect(stats.closed).toBe(stats.opened);
  expect(stats.databaseCloseActive).toEqual([0, 0]);
  await expect(fs.stat(path.join(f.output, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
