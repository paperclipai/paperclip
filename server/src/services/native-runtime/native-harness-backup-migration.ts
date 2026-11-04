import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeHarnessBackups, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { nativeHarnessStateBase, readNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { persistNativeHarnessBackup, verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { MAX_NATIVE_HARNESS_BYTES, MAX_NATIVE_HARNESS_OBJECT_BYTES } from "./native-harness-backup-archive.js";
import { offlineMigrationExecutionWhere } from "../offline-migration-execution.js";

export async function hasLocalNativeHarnessObligations(db: Db): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from agent_task_sessions s
    join heartbeat_runs r on r.id = s.last_run_id and r.company_id = s.company_id and r.agent_id = s.agent_id
    join environment_leases e on e.company_id = r.company_id and e.issue_id = r.native_issue_id
      and e.metadata->'nativeHarnessBackup'->>'normalizedSessionId' = r.native_session_id::text
    where s.adapter_type = 'paperclip_runner'
      and e.metadata->'nativeHarnessBackup'->>'schema' = 'paperclip.native-harness-backup-stamp.v2'
      and not exists (select 1 from native_harness_backups b where b.company_id = r.company_id
        and b.scope_digest = e.metadata->'nativeHarnessBackup'->>'sessionScopeSha256' and b.status = 'current')
    limit 1`);
  return rows.length > 0;
}

const MAX_PARALLEL_BACKUPS = 4;
// An archive and its encrypted copy coexist. Keep the same worst-case scratch
// bound as one maximum-size serial transfer, including tar header overhead.
const MAX_SCRATCH_BYTES = 2 * MAX_NATIVE_HARNESS_OBJECT_BYTES;

async function prepareSource(base: string, scopeDigest: string) {
  const root = join(base, scopeDigest, "failover-backups", "current");
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("native_harness_migration_unsafe_source");
  const manifestBytes = await readFile(join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const state = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8"));
  if (state.lifecycle !== "suspended" || typeof state.runId !== "string"
    || manifest.schema !== "paperclip.native-harness-backup.v1") throw new Error("native_harness_migration_source_unsettled");
  const names = new Set<string>();
  let bytes = manifestBytes.length, closed = Array.isArray(manifest.directories) && manifest.directories.length > 0;
  for (const value of Array.isArray(manifest.directories) ? manifest.directories : []) {
    const entry = value as { name?: unknown; bytes?: unknown } | null;
    if (!entry || typeof entry.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.name)
      || [".", ".."].includes(entry.name) || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) { closed = false; break; }
    names.add(entry.name); bytes += Number(entry.bytes);
  }
  const entries = await readdir(root, { withFileTypes: true });
  closed &&= entries.length === names.size + 1 && entries.every(entry => entry.name === "manifest.json"
    ? entry.isFile() : names.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink());
  // Unknown extra files are preserved with an exclusive full-size reservation.
  const archiveLimit = closed && Number.isSafeInteger(bytes) && bytes <= MAX_NATIVE_HARNESS_BYTES
    ? Math.min(MAX_NATIVE_HARNESS_OBJECT_BYTES, bytes + MAX_NATIVE_HARNESS_OBJECT_BYTES - MAX_NATIVE_HARNESS_BYTES)
    : MAX_NATIVE_HARNESS_OBJECT_BYTES;
  return { root, scopeDigest, runId: state.runId as string, archiveLimit,
    sessionId: manifest.normalizedSessionId, runnerId: manifest.runnerInstanceId,
    manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` };
}

type Source = NonNullable<Awaited<ReturnType<typeof prepareSource>>>;

async function migrateSource(db: Db, input: { storage: StorageService; signal: AbortSignal }, source: Source) {
  input.signal.throwIfAborted();
  const { root, scopeDigest, manifestSha256 } = source;
  const [run] = await db.select({ companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.nativeIssueId,
    sessionId: heartbeatRuns.nativeSessionId, runnerId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, source.runId));
  if (!run) return 0;
  if (!run.issueId || run.sessionId !== source.sessionId || run.runnerId !== source.runnerId) {
    throw new Error("native_harness_migration_binding_mismatch");
  }
  const [current] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, run.companyId),
    eq(nativeHarnessBackups.scopeDigest, scopeDigest), eq(nativeHarnessBackups.status, "current")));
  if (current) {
    if (current.manifestSha256 !== manifestSha256) throw new Error("native_harness_migration_durable_source_conflict");
    await verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: run.companyId,
      scopeDigest, manifestSha256: current.manifestSha256, signal: input.signal });
    return 1;
  }
  const leases = await db.select({ stamp: sql<unknown>`${environmentLeases.metadata}->'nativeHarnessBackup'`,
    providerLeaseId: environmentLeases.providerLeaseId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.issueId, run.issueId),
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'manifestSha256' = ${manifestSha256}`));
  let valid = false;
  for (const lease of leases) {
    const stamp = readNativeHarnessBackupStamp(lease.stamp, lease.providerLeaseId ?? "");
    if (stamp?.sessionScopeSha256 === scopeDigest && await verifyNativeHarnessBackupStampAsync(stamp, lease.providerLeaseId!, input.signal)) { valid = true; break; }
  }
  if (!valid) throw new Error("native_harness_migration_backup_unverified");
  await persistNativeHarnessBackup({ db, storage: input.storage, root, scopeDigest, signal: input.signal,
    maxArchiveBytes: source.archiveLimit,
    owner: { kind: "offline_migration", writersStopped: true, companyId: run.companyId, issueId: run.issueId, runId: source.runId } });
  return 1;
}

export async function migrateNativeHarnessBackups(db: Db, input: {
  storage: StorageService; writersStopped: true; signal: AbortSignal;
}): Promise<number> {
  if (!input.writersStopped) throw new Error("native_harness_migration_requires_offline_writers");
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(offlineMigrationExecutionWhere()).limit(1);
  if (active) throw new Error("native_harness_migration_requires_offline_writers");
  const base = nativeHarnessStateBase();
  const directories = await readdir(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]; throw error;
  });
  let count = 0, reserved = 0, wave: Source[] = [];
  const flush = async () => {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([input.signal, cancellation.signal]);
    const settled = await Promise.allSettled(wave.map(async source => {
      try { return await migrateSource(db, { ...input, signal }, source); }
      catch (error) { cancellation.abort(error); throw error; }
    }));
    // Never return failure while a peer can still upload or publish. Partial
    // completed transfers remain valid for the next offline attempt.
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      count += result.value;
    }
    wave = []; reserved = 0;
  };
  for (const scopeDigest of directories.filter(name => /^[a-f0-9]{64}$/.test(name)).sort()) {
    input.signal.throwIfAborted();
    const source = await prepareSource(base, scopeDigest);
    if (!source) continue;
    const reservation = 2 * source.archiveLimit;
    if (wave.length && (wave.length === MAX_PARALLEL_BACKUPS || reserved + reservation > MAX_SCRATCH_BYTES)) await flush();
    wave.push(source); reserved += reservation;
  }
  if (wave.length) await flush();
  return count;
}
