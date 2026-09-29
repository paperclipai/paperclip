import { parentPort, workerData } from "node:worker_threads";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { AuthorityCommit, AuthorityRecord, AuthoritySnapshot, AuthorityWorkRecord } from "./durable-authority-store.js";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const { authorityInteger, authorityJson, validateAuthorityCommit, validateAuthorityPage, validateAuthorityWorkKey, validateAuthorityWorkPage, DurableAuthorityStoreError } =
  await import(new URL(`./durable-authority-store.${extension}`, import.meta.url).href) as typeof import("./durable-authority-store.js");
const { defaultStorageRunnerBinary } = await import(new URL(`./native-storage-command.${extension}`, import.meta.url).href) as typeof import("./native-storage-command.js");
const { path, binding, create, readOnly, runnerBinary } = workerData as { path: string; binding: string; create: boolean; readOnly?: boolean; runnerBinary?: string };
type Code = InstanceType<typeof DurableAuthorityStoreError>["code"];
function fail(code: Code, message: string): never { throw new DurableAuthorityStoreError(code, message); }
function privateFile(path: string): void {
  // Workers share a POSIX process: opening and closing a probe descriptor can
  // cancel SQLite's locks held by a different worker. SQLite owns all database
  // and sidecar descriptors; the private-directory preflight is metadata only.
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) fail("invalid_authority", "unsafe storage file");
}
let database: DatabaseSync | undefined;
let legacy = false;
let startupError: unknown;
try {
  if (readOnly && create) fail("invalid_authority", "a proof reader cannot create authority");
  if (typeof binding !== "string" || !binding.length || binding.length > 1024 || /[\x00-\x1f]/.test(binding)) fail("invalid_authority", "invalid storage binding");
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))) fail("invalid_authority", "unsafe storage directory");
  const exists = lstatSync(path, { throwIfNoEntry: false });
  if (!exists && !create) fail("storage_unavailable", "activated store is missing");
  if (exists) {
    for (const suffix of ["", "-wal", "-shm"]) if (!suffix || lstatSync(path + suffix, { throwIfNoEntry: false })) privateFile(path + suffix);
    database = new DatabaseSync(resolve(realpathSync(dirname(path)), basename(path)), { readOnly: true });
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000;");
    legacy = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_binding'").get();
    if (!legacy) {
      const stored = database.prepare("SELECT schema_version,binding FROM store_binding WHERE singleton=1").get();
      if (stored?.schema_version !== 2 || stored.binding !== binding) fail("invalid_authority", "storage binding or version mismatch");
    }
    if (legacy || !readOnly) { database.close(); database = undefined; }
  }
} catch (error) { database?.close(); database = undefined; startupError = error; }

if (legacy && !startupError) {
  // Retained v1 files keep their original format; only fresh stores select v2.
  await import(new URL(`./legacy-sqlite-authority-worker.${extension}`, import.meta.url).href);
} else {
  type Reply = { id: number; value?: unknown; error?: { code: Code; message: string } };
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let requestId = 0, closing = false, stderr = "";
  let failed: Error | undefined;
  let output = Buffer.alloc(0);
  const child = !startupError && !readOnly ? spawn(runnerBinary ?? defaultStorageRunnerBinary(), ["storage", "rpc", "--path", path, "--binding", binding, "--create", String(create)], { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) : undefined;
  function fence(error: Error) {
    failed ??= error;
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
  }
  child?.stdout.on("data", (chunk: Buffer) => {
    if (output.length + chunk.length > 96 * 1024 * 1024) { fence(new DurableAuthorityStoreError("storage_pressure", "storage response exceeds capacity")); child.kill(); return; }
    output = Buffer.concat([output, chunk]);
    for (;;) {
      const end = output.indexOf(10);
      if (end < 0) break;
      const line = output.subarray(0, end); output = output.subarray(end + 1);
      try {
        const message = JSON.parse(line.toString()) as Reply;
        const request = pending.get(message.id);
        if (!request) fail("invalid_authority", "unexpected storage response");
        pending.delete(message.id);
        if (message.error) request.reject(new DurableAuthorityStoreError(message.error.code, message.error.message));
        else request.resolve(message.value);
      } catch (error) { fence(error as Error); child.kill(); }
    }
  });
  child?.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child?.once("error", error => fence(new DurableAuthorityStoreError("storage_unavailable", error.message)));
  child?.once("exit", code => { if (!closing || code !== 0 || pending.size) fence(new DurableAuthorityStoreError("storage_unavailable", stderr.trim() || `storage process exited (${code})`)); });
  child?.stdin.on("error", error => fence(new DurableAuthorityStoreError("storage_unavailable", error.message)));
  parentPort!.once("close", () => { child?.stdin.end(); });
  function rpc<T>(operation: string, input: unknown): Promise<T> {
    if (failed) return Promise.reject(failed);
    if (!child) return Promise.reject(new DurableAuthorityStoreError("storage_unavailable", "storage process is absent"));
    do { requestId = requestId >= 0xffff_ffff ? 1 : requestId + 1; }
    while (pending.has(requestId));
    const id = requestId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject });
      child.stdin.write(`${JSON.stringify({ id, operation, input })}\n`);
    });
  }
  const namespace = (epoch: string, kind: AuthorityRecord["kind"]) => `authority/${kind}/${epoch}`;
  const sequenceNamespace = (epoch: string, kind: AuthorityRecord["kind"]) => `sequence/${kind}/${epoch}`;
  const encoded = (value: unknown) => Buffer.from(authorityJson(value)).toString("base64");
  const decode = <T>(bytes: string): T => JSON.parse(Buffer.from(bytes, "base64").toString()) as T;
  async function get(namespace: string, key: string): Promise<AuthorityRecord | null> {
    const bytes = await rpc<string | null>("get", { namespace, key });
    return bytes === null ? null : decode<AuthorityRecord>(bytes);
  }
  type NativeWork = { key: string; bytes: string; digest: string };
  const decodeWork = (collection: AuthorityWorkRecord["collection"], row: NativeWork): AuthorityWorkRecord => ({ collection, id: row.key, body: decode(row.bytes), sha256: Buffer.from(row.digest, "base64").toString("hex") });
  async function dispatch(operation: string, input: Record<string, unknown>): Promise<unknown> {
    if (startupError) throw startupError;
    if (readOnly) {
      if (operation === "ready") return { unorderedEffectReceipts: true, commandEpochs: true, eventEpochs: true };
      if (operation === "close") { database!.close(); return null; }
      if (operation === "commit") fail("invalid_authority", "proof readers cannot commit authority");
      if (!["load", "getWork", "readWorkPage", "getRecord"].includes(operation)) fail("invalid_authority", "proof readers expose current authority and exact references only");
      database!.exec("BEGIN");
      try {
      if (database!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_manifest'").get()
        && database!.prepare("SELECT complete FROM backup_manifest WHERE singleton=1").get()?.complete !== 1) fail("invalid_authority", "indexed backup is incomplete");
      const statement = database!.prepare("SELECT generation,CASE WHEN length(bytes)<=16777216 THEN bytes END AS bytes,CASE WHEN length(digest)=32 THEN digest END AS digest FROM current_state WHERE key='authority'");
      statement.setReadBigInts(true);
      const row = statement.get();
      if (!row && operation === "load") return null;
      if (!row) fail("stale_authority", "outstanding work has no current authority");
      if (!(row.bytes instanceof Uint8Array) || !(row.digest instanceof Uint8Array) || !createHash("sha256").update(row.bytes).digest().equals(Buffer.from(row.digest))) fail("invalid_authority", "current authority digest mismatch");
      const preparedStatement = database!.prepare("SELECT generation,CASE WHEN length(body)<=16777216 THEN body END AS body,digest FROM receipt_prepare WHERE state_key='authority'");
      preparedStatement.setReadBigInts(true);
      const prepared = preparedStatement.get();
      if (prepared && (prepared.generation !== row.generation || !(prepared.body instanceof Uint8Array) || !(prepared.digest instanceof Uint8Array)
        || !Buffer.from(prepared.body).equals(Buffer.from(row.bytes)) || !Buffer.from(prepared.digest).equals(Buffer.from(row.digest)))) fail("invalid_authority", "current authority has conflicting prepared receipts");
      if (operation === "getRecord") {
        const { stdout } = await promisify(execFile)(runnerBinary ?? defaultStorageRunnerBinary(), ["storage", "read-receipt", "--path", path,
          "--binding", binding, "--generation", String(row.generation), "--namespace", namespace(String(input.epoch), input.kind as AuthorityRecord["kind"]), "--key", String(input.id)],
        { env: {}, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        const bytes = JSON.parse(stdout) as string | null;
        return bytes === null ? null : decode<AuthorityRecord>(bytes);
      }
      if (operation !== "load") {
        const collection = String(input.collection) as AuthorityWorkRecord["collection"];
        const get = (id: string): AuthorityWorkRecord | null => {
          validateAuthorityWorkKey(collection, id);
          if (!database!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_work'").get()) return null;
          const row = database!.prepare("SELECT CASE WHEN length(bytes)<=16384 THEN bytes END AS bytes,CASE WHEN length(digest)=32 THEN digest END AS digest FROM current_work WHERE collection=? AND key=?").get(collection, id);
          if (!row) return null;
          if (!(row.bytes instanceof Uint8Array) || !(row.digest instanceof Uint8Array) || !createHash("sha256").update(row.bytes).digest().equals(Buffer.from(row.digest))) fail("invalid_authority", "outstanding-work digest mismatch");
          return { collection, id, body: JSON.parse(Buffer.from(row.bytes).toString()), sha256: Buffer.from(row.digest).toString("hex") };
        };
        if (operation === "getWork") return get(String(input.id));
        const after = String(input.after), limit = Number(input.limit), generation = String(input.expectedGeneration);
        validateAuthorityWorkPage(collection, after, limit, generation);
        if (String(row.generation) !== generation) fail("stale_authority", "outstanding-work page generation changed");
        if (!database!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_work'").get()) return { records: [], nextAfter: null };
        const rows = database!.prepare("SELECT key FROM current_work WHERE collection=? AND key>? ORDER BY key LIMIT ?").all(collection, after, limit);
        const records = rows.map(row => get(String(row.key))!);
        return { records, nextAfter: records.at(-1)?.id ?? null };
      }
      return { generation: String(row.generation), state: JSON.parse(Buffer.from(row.bytes).toString()) };
      } finally { database!.exec("ROLLBACK"); }
    }
    switch (operation) {
      case "ready": await rpc("ready", {}); return { unorderedEffectReceipts: true, commandEpochs: true, eventEpochs: true };
      case "load": {
        const value = await rpc<{ generation: string; bytes: string } | null>("load", { key: "authority" });
        return value && { generation: value.generation, state: decode<AuthoritySnapshot["state"]>(value.bytes) };
      }
      case "getRecord": return get(namespace(String(input.epoch), input.kind as AuthorityRecord["kind"]), String(input.id));
      case "getSessionEffect": return get("session-effects", String(input.id));
      case "getWork": {
        const collection = String(input.collection) as AuthorityWorkRecord["collection"], id = String(input.id);
        validateAuthorityWorkKey(collection, id);
        const row = await rpc<NativeWork | null>("getWork", { collection, key: id });
        return row && decodeWork(collection, row);
      }
      case "readWorkPage": {
        const collection = String(input.collection) as AuthorityWorkRecord["collection"], after = String(input.after), limit = Number(input.limit), expectedGeneration = String(input.expectedGeneration);
        validateAuthorityWorkPage(collection, after, limit, expectedGeneration);
        const assertGeneration = async () => {
          const state = await rpc<{ generation: string } | null>("load", { key: "authority" });
          if (!state || state.generation !== expectedGeneration) fail("stale_authority", "outstanding-work page generation changed");
        };
        await assertGeneration();
        const rows = await rpc<NativeWork[]>("workPage", { collection, after, limit: String(limit) });
        await assertGeneration();
        return { records: rows.map(row => decodeWork(collection, row)), nextAfter: rows.at(-1)?.key ?? null };
      }
      case "commit": {
        const commit = input as unknown as AuthorityCommit;
        validateAuthorityCommit(commit);
        const receipts = commit.records.flatMap(record => {
          const bytes = encoded(record);
          const entries = [{ namespace: namespace(record.epoch, record.kind), key: record.id, bytes }];
          if (record.kind === "effect") entries.push({ namespace: "session-effects", key: record.id, bytes });
          else entries.push({ namespace: sequenceNamespace(record.epoch, record.kind) + (record.sequenceEpoch ? `/${record.sequenceEpoch}` : ""), key: record.sequence.padStart(19, "0"), bytes: encoded(record.id) });
          return entries;
        });
        const work = (commit.work ?? []).map(change => ({ collection: change.collection, key: change.id,
          expectedDigest: change.expectedSha256 === null ? null : Buffer.from(change.expectedSha256, "hex").toString("base64"), bytes: change.body === null ? null : encoded(change.body) }));
        return rpc("commit", { key: "authority", expectedGeneration: commit.expectedGeneration, bytes: encoded(commit.state), receipts, work });
      }
      case "readEvents": {
        const epoch = String(input.epoch), after = String(input.after), limit = Number(input.limit), byteBudget = Number(input.byteBudget);
        validateAuthorityPage(after, limit, byteBudget, input.sequenceEpoch as string | undefined);
        const rows = await rpc<Array<{ key: string; bytes: string }>>("page", { namespace: sequenceNamespace(epoch, "event") + (input.sequenceEpoch ? `/${input.sequenceEpoch}` : ""), after: authorityInteger(after).toString().padStart(19, "0"), limit: String(limit), byteBudget: "1048576" });
        const records: AuthorityRecord[] = [];
        let bytes = 0;
        for (const row of rows) {
          const record = await get(namespace(epoch, "event"), decode<string>(row.bytes));
          if (!record || record.sequenceEpoch !== input.sequenceEpoch || record.sequence.padStart(19, "0") !== row.key) fail("invalid_authority", "receipt sequence index changed");
          const size = Buffer.byteLength(authorityJson(record.body));
          if (bytes + size > byteBudget) break;
          bytes += size; records.push(record);
        }
        return { records, nextAfter: records.at(-1)?.sequence ?? null };
      }
      case "close": {
        closing = true;
        const exited = new Promise<void>((resolve, reject) => { child!.once("exit", code => code === 0 ? resolve() : reject(new Error(`storage close failed (${code})`))); });
        await rpc("close", {}); child!.stdin.end(); await exited; return null;
      }
      default: fail("invalid_authority", "unknown storage operation");
    }
  }
  // Serialize temporary copies and commit order; the owner admits at most 8.
  let chain = Promise.resolve();
  parentPort!.on("message", ({ id, operation, input }: { id: number; operation: string; input: Record<string, unknown> }) => {
    chain = chain.then(async () => {
      try { parentPort!.postMessage({ id, value: await dispatch(operation, input) }); }
      catch (error) { parentPort!.postMessage({ id, error: { code: error instanceof DurableAuthorityStoreError ? error.code : "storage_unavailable", message: error instanceof Error ? error.message : "storage worker failed" } }); }
    });
  });
}
