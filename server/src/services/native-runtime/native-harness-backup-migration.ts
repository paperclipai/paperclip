import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { nativeHarnessStateBase, readNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { MAX_NATIVE_HARNESS_BYTES, MAX_NATIVE_HARNESS_OBJECT_BYTES, nativeHarnessArchiveSizeLimit } from "./native-harness-backup-archive.js";
import { offlineMigrationExecutionWhere } from "../offline-migration-execution.js";
import { NativeHarnessBackupSourceError, readNativeHarnessBackupSource } from "./native-harness-backup-source.js";

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
  const files = await readNativeHarnessBackupSource(root);
  if (!files) return null;
  const { manifestBytes, manifest, state } = files;
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
    ? nativeHarnessArchiveSizeLimit(bytes)
    : MAX_NATIVE_HARNESS_OBJECT_BYTES;
  return { root, scopeDigest, runId: state.runId as string, archiveLimit,
    sessionId: manifest.normalizedSessionId, runnerId: manifest.runnerInstanceId,
    manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` };
}

type Source = NonNullable<Awaited<ReturnType<typeof prepareSource>>>;

async function sourceRun(db: Db, source: Source) {
  const [run] = await db.select({ companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.nativeIssueId,
    sessionId: heartbeatRuns.nativeSessionId, runnerId: heartbeatRuns.runnerInstanceId,
    status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, source.runId));
  if (!run) return null;
  if (!run.issueId || !run.sessionId || !run.runnerId || run.sessionId !== source.sessionId || run.runnerId !== source.runnerId) {
    throw new Error("native_harness_migration_binding_mismatch");
  }
  return { ...run, issueId: run.issueId, sessionId: run.sessionId, runnerId: run.runnerId };
}

async function verifiedSourceLease(db: Db, source: Source, run: NonNullable<Awaited<ReturnType<typeof sourceRun>>>, signal: AbortSignal) {
  const leases = await db.select({ stamp: sql<unknown>`${environmentLeases.metadata}->'nativeHarnessBackup'`,
    providerLeaseId: environmentLeases.providerLeaseId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.issueId, run.issueId),
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'manifestSha256' = ${source.manifestSha256}`));
  for (const lease of leases) {
    const stamp = readNativeHarnessBackupStamp(lease.stamp, lease.providerLeaseId ?? "");
    if (stamp?.sessionScopeSha256 === source.scopeDigest && await verifyNativeHarnessBackupStampAsync(stamp, lease.providerLeaseId!, signal)) return lease.providerLeaseId!;
  }
  return null;
}

async function migrateSource(db: Db, input: { storage: StorageService; signal: AbortSignal }, source: Source) {
  input.signal.throwIfAborted();
  const { root, scopeDigest, manifestSha256 } = source, run = await sourceRun(db, source);
  if (!run) return 0;
  const [current] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, run.companyId),
    eq(nativeHarnessBackups.scopeDigest, scopeDigest), eq(nativeHarnessBackups.status, "current")));
  if (current) {
    if (current.manifestSha256 !== manifestSha256) throw new Error("native_harness_migration_durable_source_conflict");
    await verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: run.companyId,
      scopeDigest, manifestSha256: current.manifestSha256, signal: input.signal });
    return 1;
  }
  if (!await verifiedSourceLease(db, source, run, input.signal)) throw new Error("native_harness_migration_backup_unverified");
  await persistNativeHarnessBackup({ db, storage: input.storage, root, scopeDigest, signal: input.signal,
    maxArchiveBytes: source.archiveLimit,
    owner: { kind: "offline_migration", writersStopped: true, companyId: run.companyId, issueId: run.issueId, runId: source.runId } });
  return 1;
}

async function mapSources<T>(input: { signal: AbortSignal; concurrency?: number;
  unavailableSource?: (error: unknown, scopeDigest: string) => T | undefined }, visit: (source: Source, signal: AbortSignal) => Promise<T>) {
  const base = nativeHarnessStateBase();
  const directories = await readdir(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]; throw error;
  });
  let reserved = 0, wave: Source[] = [];
  const results: T[] = [];
  const flush = async () => {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([input.signal, cancellation.signal]);
    const settled = await Promise.allSettled(wave.map(async source => {
      try { return await visit(source, signal); }
      catch (error) { cancellation.abort(error); throw error; }
    }));
    // Never return failure while a peer can still upload or publish. Partial
    // completed transfers remain valid for the next offline attempt.
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
    wave = []; reserved = 0;
  };
  for (const scopeDigest of directories.filter(name => /^[a-f0-9]{64}$/.test(name)).sort()) {
    input.signal.throwIfAborted();
    let source;
    try { source = await prepareSource(base, scopeDigest); }
    catch (error) {
      input.signal.throwIfAborted();
      const deferred = input.unavailableSource?.(error, scopeDigest);
      if (deferred === undefined) throw error;
      results.push(deferred); continue;
    }
    if (!source) continue;
    const reservation = 2 * source.archiveLimit;
    if (wave.length && (wave.length === (input.concurrency ?? MAX_PARALLEL_BACKUPS) || reserved + reservation > MAX_SCRATCH_BYTES)) await flush();
    wave.push(source); reserved += reservation;
  }
  if (wave.length) await flush();
  return results;
}

export async function migrateNativeHarnessBackups(db: Db, input: {
  storage: StorageService; writersStopped: true; signal: AbortSignal;
}): Promise<number> {
  if (!input.writersStopped) throw new Error("native_harness_migration_requires_offline_writers");
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(offlineMigrationExecutionWhere()).limit(1);
  if (active) throw new Error("native_harness_migration_requires_offline_writers");
  const counts = await mapSources(input, (source, signal) => migrateSource(db, { storage: input.storage, signal }, source));
  return counts.reduce<number>((total, count) => total + count, 0);
}

/** Copy settled successful history using its released runtime owner. This is
 * preparatory work, never an offline-writer assertion or enrollment receipt. */
export async function prestageNativeHarnessBackups(db: Db, input: { storage: StorageService; signal: AbortSignal }) {
  // Keep preparatory work below offline throughput so the serving process can
  // continue handling real work. This finite operation has no idle schedule.
  const deferSource = (scopeDigest: string, reason: string, outcome: string) => {
    console.warn(JSON.stringify({ schema: "paperclip.native-harness-prestage-source.v1", scopeDigest, reason }));
    return outcome;
  };
  const outcomes = await mapSources({ ...input, concurrency: 1, unavailableSource: (error, scopeDigest) => {
    if (error instanceof NativeHarnessBackupSourceError || error instanceof Error && error.message === "native_harness_migration_source_unsettled") {
      return deferSource(scopeDigest, error.message, "source_unavailable");
    }
    // This callback only receives preparation filesystem failures, never DB errors.
    if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
      return deferSource(scopeDigest, "native_harness_migration_source_unavailable", "source_unavailable");
    }
    return undefined;
  } }, async (source, signal) => {
    signal.throwIfAborted();
    const run = await sourceRun(db, source).catch(error => {
      if (error instanceof Error && error.message === "native_harness_migration_binding_mismatch") return null;
      throw error;
    });
    if (!run) return "missing_run";
    const [current] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, run.companyId),
      eq(nativeHarnessBackups.scopeDigest, source.scopeDigest), eq(nativeHarnessBackups.status, "current")));
    if (current) {
      if (current.manifestSha256 !== source.manifestSha256) return "durable_source_changed";
      await verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: run.companyId,
        scopeDigest: source.scopeDigest, manifestSha256: source.manifestSha256, signal });
      return "current";
    }
    if (run.status !== "succeeded" || !run.finishedAt) return "source_not_successful";
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.issueId, run.issueId),
      eq(nativeRunFinalizations.runId, source.runId)));
    if (coordinator?.phase !== "committed" || coordinator.leaseOwner || !coordinator.resultId || !coordinator.controllerBootId) return "owner_not_released";
    const [task] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.issueId)));
    const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
      or(eq(heartbeatRuns.nativeIssueId, run.issueId), eq(heartbeatRuns.issueId, run.issueId), eq(heartbeatRuns.nativeSessionId, run.sessionId)))).limit(1);
    if (!task || task.executionRunId || task.checkoutRunId || active) return "source_active";
    const providerLeaseId = await verifiedSourceLease(db, source, run, signal);
    if (!providerLeaseId) return "source_unverified";
    try {
      const owner = await nativeHarnessBackupOwner(db, { companyId: run.companyId, issueId: run.issueId,
        runId: source.runId, bootId: coordinator.controllerBootId });
      await persistNativeHarnessBackup({ db, storage: input.storage, root: source.root, scopeDigest: source.scopeDigest,
        owner, signal, maxArchiveBytes: source.archiveLimit,
        inactiveSource: { normalizedSessionId: run.sessionId, runnerInstanceId: run.runnerId, providerLeaseId } });
      return "published";
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof NativeHarnessBackupSourceError || error instanceof Error && ["native_runner_checkpoint_owner_lost", "native_harness_storage_owner_missing",
        "native_harness_storage_prestage_source_active", "native_harness_storage_prestage_source_changed",
        "native_harness_storage_owner_superseded", "native_harness_archive_invalid"].includes(error.message)) {
        return deferSource(source.scopeDigest, error.message, "source_changed");
      }
      throw error;
    }
  });
  const counts = { inspected: outcomes.length, published: 0, current: 0, deferred: {} as Record<string, number> };
  for (const outcome of outcomes) {
    if (outcome === "published" || outcome === "current") counts[outcome]++;
    else counts.deferred[outcome] = (counts.deferred[outcome] ?? 0) + 1;
  }
  return counts;
}
