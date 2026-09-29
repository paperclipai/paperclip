import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

function privateFile(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("indexed_state_file_unsafe");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error("indexed_state_file_changed"); offset += count; }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("indexed_state_file_changed");
    return bytes;
  } finally { closeSync(fd); }
}
try {
  const path = String(workerData.path);
  const directory = dirname(path);
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))) throw new Error("indexed_state_directory_unsafe");
  const locator = JSON.parse(privateFile(path, 4096).toString("utf8")) as { schema?: string; binding?: string };
  const type = locator.schema === "paperclip.runner.durable.state.indexed.v1" ? "runner"
    : locator.schema === "paperclip.runner.codex-provider-state.indexed.v1" ? "codex-provider" : null;
  if (!type || typeof locator.binding !== "string" || locator.binding.length > 1024) throw new Error("indexed_state_locator_invalid");
  const databasePath = resolve(realpathSync(directory), `${basename(path, ".json")}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const stat = lstatSync(databasePath + suffix, { throwIfNoEntry: false });
    if (!stat && suffix) continue;
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("indexed_state_database_unsafe");
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let result: Record<string, unknown>;
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000; PRAGMA query_only=ON;");
    const binding = db.prepare("SELECT schema_version,binding FROM store_binding WHERE singleton=1").get();
    if (![1, 2].includes(Number(binding?.schema_version)) || binding?.binding !== locator.binding) throw new Error("indexed_state_binding_mismatch");
    db.exec("BEGIN");
    const backup = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_manifest'").get();
    if (backup && db.prepare("SELECT complete FROM backup_manifest WHERE singleton=1").get()?.complete !== 1) throw new Error("indexed_state_backup_incomplete");
    const importing = db.prepare("SELECT CASE WHEN length(bytes)<=16384 THEN bytes END AS bytes,digest FROM current_state WHERE key='legacy-import'").get();
    let preparation: Record<string, unknown> | null = null;
    if (importing) {
      if (!(importing.bytes instanceof Uint8Array) || !(importing.digest instanceof Uint8Array)
          || !createHash("sha256").update(importing.bytes).digest().equals(Buffer.from(importing.digest))) throw new Error("indexed_state_import_invalid");
      const progress = JSON.parse(Buffer.from(importing.bytes).toString()) as Record<string, unknown>;
      if (progress.schema !== "paperclip.runner.local-import.v1" || progress.binding !== locator.binding || !progress.prepared) throw new Error("indexed_state_import_incomplete");
      preparation = progress.prepared as Record<string, unknown>;
    }
    const metadata = db.prepare("SELECT length(bytes) AS size FROM current_state WHERE key=?").get(type);
    if (!metadata || typeof metadata.size !== "number" || metadata.size > 32 * 1024 * 1024) throw new Error("indexed_state_snapshot_invalid");
    const statement = db.prepare("SELECT generation,bytes,CASE WHEN length(digest)=32 THEN digest END AS digest,length(bytes) AS size FROM current_state WHERE key=?");
    statement.setReadBigInts(true);
    const row = statement.get(type);
    if (!row || typeof row.generation !== "bigint" || row.generation <= 0n || Number(row.size) > 32 * 1024 * 1024 || !(row.bytes instanceof Uint8Array) || !(row.digest instanceof Uint8Array)) throw new Error("indexed_state_snapshot_invalid");
    const bytes = Buffer.from(row.bytes);
    if (!createHash("sha256").update(bytes).digest().equals(Buffer.from(row.digest))) throw new Error("indexed_state_digest_mismatch");
    const state = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const stateDigest = Buffer.from(row.digest).toString("hex");
    const generation = row.generation;
    if (binding!.schema_version === 2) {
      const pendingQuery = db.prepare("SELECT generation,CASE WHEN length(body)<=33554432 THEN body END AS body,digest FROM receipt_prepare WHERE state_key=?");
      pendingQuery.setReadBigInts(true);
      const pending = pendingQuery.get(type);
      if (pending && (pending.generation !== generation || !(pending.body instanceof Uint8Array) || !(pending.digest instanceof Uint8Array) || !bytes.equals(Buffer.from(pending.body)) || !Buffer.from(row.digest).equals(Buffer.from(pending.digest)))) throw new Error("indexed_state_prepared_commit_mismatch");
    }
    if (type === "runner") {
      const next = state.nextSourceSeq, acked = state.ackedSourceSeq;
      if (!Number.isSafeInteger(next) || !Number.isSafeInteger(acked) || Number(next) <= Number(acked)) throw new Error("indexed_state_cursor_invalid");
      // This is a proof view, not an outbox restore. A non-empty outbox remains
      // a negative fence without loading the pending payloads into the server.
      state.outbox = Number(next) === Number(acked) + 1 ? [] : [{ indexedPending: true }];
    }
    result = { state, generation: String(generation), stateDigest, preparation };
  } finally { db.close(); }
  parentPort!.postMessage(result);
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "indexed_state_reader_failed" });
}
