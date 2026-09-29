import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import type { AuthorityCommit, AuthorityRecord, AuthorityWorkRecord } from "./durable-authority-store.js";

// Support the source checkout and the compiled package without inheriting a
// test runner's loader into a storage worker. These modules are type-strippable.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const { authorityInteger, authorityJson, validateAuthorityCommit, validateAuthorityPage, validateAuthorityWorkKey, validateAuthorityWorkPage, DurableAuthorityStoreError, MAX_AUTHORITY_RECORD_BYTES } =
  await import(new URL(`./durable-authority-store.${extension}`, import.meta.url).href) as typeof import("./durable-authority-store.js");

const { path, binding, create, readOnly } = workerData as { path: string; binding: string; create: boolean; readOnly?: boolean };
let database: DatabaseSync;

function digest(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function fail(code: InstanceType<typeof DurableAuthorityStoreError>["code"], message: string): never { throw new DurableAuthorityStoreError(code, message); }

function privateFile(filePath: string, optional: boolean): void {
  let fd: number;
  try { fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) fail("invalid_authority", "unsafe storage file");
  } finally { closeSync(fd); }
}

function openDatabase(): DatabaseSync {
  if (create && readOnly) fail("invalid_authority", "a proof reader cannot create authority");
  if (typeof binding !== "string" || !binding.length || binding.length > 1024 || /[\x00-\x1f]/.test(binding)) fail("invalid_authority", "invalid storage binding");
  if (create && !existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())))) fail("invalid_authority", "unsafe storage directory");
  if (create) {
    try { const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { fsyncSync(fd); } finally { closeSync(fd); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  for (const suffix of ["", "-wal", "-shm"]) privateFile(`${path}${suffix}`, suffix.length > 0);
  const db = new DatabaseSync(resolve(realpathSync(dirname(path)), basename(path)), { enableForeignKeyConstraints: true, readOnly });
  try {
    const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.version).split(".").map(Number);
    if ((version[0]! * 1_000_000 + version[1]! * 1_000 + version[2]!) < 3_051_003) fail("storage_unavailable", "SQLite build lacks the WAL-reset fix");
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000;");
    if (readOnly) db.exec("PRAGMA query_only=ON");
    else db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;");
    if (create) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS authority_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL, binding TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS authority_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL CHECK(generation>0), body TEXT NOT NULL, digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS authority_records (epoch TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(epoch,kind,id), UNIQUE(epoch,kind,sequence)) WITHOUT ROWID;
          CREATE UNIQUE INDEX IF NOT EXISTS authority_session_effect ON authority_records(id) WHERE kind='effect';`);
        db.prepare("INSERT OR IGNORE INTO authority_binding VALUES (1,1,?)").run(binding);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (process.platform !== "win32") {
        const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    const stored = db.prepare("SELECT schema_version,binding FROM authority_binding WHERE singleton=1").get();
    if (stored?.schema_version !== 1 || stored.binding !== binding) fail("invalid_authority", "storage binding or version mismatch");
    if (!readOnly) db.exec("CREATE TABLE IF NOT EXISTS authority_work(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(collection,id)) WITHOUT ROWID");
    return db;
  } catch (error) { db.close(); throw error; }
}

function exactStatement(sql: string): StatementSync {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function decode(row: Record<string, unknown>): AuthorityRecord {
  if (typeof row.body !== "string" || row.digest !== digest(row.body)) fail("invalid_authority", "receipt digest mismatch");
  return { epoch: String(row.epoch), kind: row.kind as AuthorityRecord["kind"], id: String(row.id), sequence: String(row.sequence), body: JSON.parse(row.body) };
}

function dispatch(operation: string, input: Record<string, unknown>): unknown {
  switch (operation) {
    case "ready": return null;
    case "getWork": {
      const collection = String(input.collection), id = String(input.id);
      validateAuthorityWorkKey(collection, id);
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_work'").get()) return null;
      const row = database.prepare("SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body,digest FROM authority_work WHERE collection=? AND id=?").get(collection, id);
      if (!row) return null;
      if (typeof row.body !== "string" || row.digest !== digest(row.body)) fail("invalid_authority", "outstanding-work digest mismatch");
      return { collection, id, body: JSON.parse(row.body), sha256: row.digest };
    }
    case "readWorkPage": {
      const collection = String(input.collection), after = String(input.after), limit = Number(input.limit), generation = String(input.expectedGeneration);
      validateAuthorityWorkPage(collection, after, limit, generation);
      database.exec("BEGIN");
      try {
        const current = exactStatement("SELECT generation FROM authority_state WHERE singleton=1").get()?.generation;
        if (String(current) !== generation) fail("stale_authority", "outstanding-work page generation changed");
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_work'").get()) return { records: [], nextAfter: null };
        const ids = database.prepare("SELECT id FROM authority_work WHERE collection=? AND id>? ORDER BY id LIMIT ?").all(collection, after, limit);
        const records = ids.map(row => dispatch("getWork", { collection, id: row.id }) as AuthorityWorkRecord);
        return { records, nextAfter: records.at(-1)?.id ?? null };
      } finally { database.exec("ROLLBACK"); }
    }
    case "load": {
      const row = exactStatement("SELECT generation,CASE WHEN length(CAST(body AS BLOB))<=16777216 THEN body END AS body,substr(digest,1,65) AS digest FROM authority_state WHERE singleton=1").get();
      if (!row) return null;
      if (typeof row.body !== "string" || row.digest !== digest(row.body)) fail("invalid_authority", "current authority digest mismatch");
      return { generation: String(row.generation), state: JSON.parse(row.body) };
    }
    case "getRecord": {
      const row = exactStatement("SELECT epoch,kind,id,sequence,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body END AS body,substr(digest,1,65) AS digest FROM authority_records WHERE epoch=? AND kind=? AND id=?").get(String(input.epoch), String(input.kind), String(input.id));
      return row ? decode(row) : null;
    }
    case "getSessionEffect": {
      const row = exactStatement("SELECT epoch,kind,id,sequence,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body END AS body,substr(digest,1,65) AS digest FROM authority_records WHERE kind='effect' AND id=?").get(String(input.id));
      return row ? decode(row) : null;
    }
    case "readEvents": {
      const after = String(input.after), limit = Number(input.limit), byteBudget = Number(input.byteBudget);
      validateAuthorityPage(after, limit, byteBudget);
      database.exec("BEGIN");
      const records: AuthorityRecord[] = [];
      try {
        const rows = exactStatement("SELECT id,sequence,length(CAST(body AS BLOB)) AS bytes FROM authority_records WHERE epoch=? AND kind='event' AND sequence>? ORDER BY sequence LIMIT ?").all(String(input.epoch), authorityInteger(after), limit);
        let bytes = 0;
        for (const row of rows) {
          const size = Number(row.bytes);
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_AUTHORITY_RECORD_BYTES) fail("invalid_authority", "receipt exceeds byte capacity");
          if (bytes + size > byteBudget) break;
          const record = dispatch("getRecord", { epoch: input.epoch, kind: "event", id: row.id }) as AuthorityRecord | null;
          if (!record) fail("invalid_authority", "receipt disappeared");
          bytes += size;
          records.push(record);
        }
      } finally { database.exec("ROLLBACK"); }
      return { records, nextAfter: records.at(-1)?.sequence ?? null };
    }
    case "commit": {
      if (readOnly) fail("invalid_authority", "proof readers cannot commit authority");
      const commit = input as unknown as AuthorityCommit;
      validateAuthorityCommit(commit);
      if (commit.records.some(record => record.sequenceEpoch !== undefined)) fail("invalid_authority", "retained v1 store cannot rotate command sequences");
      if (commit.records.some(record => record.kind === "effect" && record.sequence === "0")) fail("invalid_authority", "retained v1 store requires ordered effect receipts");
      const expected = authorityInteger(commit.expectedGeneration), generation = expected + 1n;
      authorityInteger(String(generation));
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = exactStatement("SELECT generation FROM authority_state WHERE singleton=1").get()?.generation ?? 0n;
        if (current !== expected) fail("stale_authority", "authority generation changed");
        for (const change of commit.work ?? []) {
          const previous = dispatch("getWork", { collection: change.collection, id: change.id }) as AuthorityWorkRecord | null;
          if ((previous?.sha256 ?? null) !== change.expectedSha256) fail("stale_authority", "outstanding-work digest changed");
          if (change.body === null) database.prepare("DELETE FROM authority_work WHERE collection=? AND id=?").run(change.collection, change.id);
          else {
            const body = authorityJson(change.body);
            database.prepare("INSERT INTO authority_work VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body,digest=excluded.digest").run(change.collection, change.id, body, digest(body));
          }
        }
        for (const record of commit.records) {
          const body = authorityJson(record.body);
          const existing = exactStatement("SELECT sequence,CASE WHEN length(CAST(body AS BLOB))<=1048576 THEN body END AS body,substr(digest,1,65) AS digest FROM authority_records WHERE epoch=? AND kind=? AND id=?").get(record.epoch, record.kind, record.id);
          if (existing) {
            if (String(existing.sequence) !== record.sequence || existing.body !== body || existing.digest !== digest(body)) fail("receipt_conflict", "exact receipt differs");
          } else {
            const sequenceOwner = database.prepare("SELECT id FROM authority_records WHERE epoch=? AND kind=? AND sequence=?").get(record.epoch, record.kind, authorityInteger(record.sequence));
            if (sequenceOwner) fail("receipt_conflict", "receipt sequence already belongs to another identity");
            database.prepare("INSERT INTO authority_records(epoch,kind,id,sequence,body,digest) VALUES (?,?,?,?,?,?)").run(record.epoch, record.kind, record.id, authorityInteger(record.sequence), body, digest(body));
          }
        }
        const body = authorityJson(commit.state);
        database.prepare("INSERT INTO authority_state(singleton,generation,body,digest) VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,body=excluded.body,digest=excluded.digest").run(generation, body, digest(body));
        database.exec("COMMIT");
        return String(generation);
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    }
    case "close": database.close(); return null;
    default: fail("invalid_authority", "unknown storage operation");
  }
}

let startupError: unknown;
try { database = openDatabase(); } catch (error) { startupError = error; }
parentPort!.on("message", ({ id, operation, input }: { id: number; operation: string; input: Record<string, unknown> }) => {
  try {
    if (startupError) throw startupError;
    parentPort!.postMessage({ id, value: dispatch(operation, input) });
  } catch (error) {
    parentPort!.postMessage({ id, error: { code: error instanceof DurableAuthorityStoreError ? error.code : "storage_unavailable", message: error instanceof Error ? error.message : "storage worker failed" } });
  }
});
