import { createReadStream, promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import type { Config } from "../config.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  prepareRunLogArchiveSource,
  resolveRunLogBasePath,
  type RunLogArchiveSource,
} from "./run-log-store.js";
import { getRunLogArchiveStorageProvider } from "../storage/index.js";

/**
 * Run-log cold-archive sweeper.
 *
 * Steps 1+2 gave us compress-on-complete (~88x) + a per-run size cap. Step 3
 * closes the lifecycle: keep the (now tiny) compressed logs hot for
 * `hotRetentionDays`, then move older *terminal* runs to object storage keyed
 * `run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`, verify the upload, flip
 * the DB tier pointer to `s3`, and delete the hot copy. A per-company fairness
 * budget archives a noisy tenant's oldest terminal runs early so one company
 * cannot starve the shared volume between age sweeps.
 *
 * The sweeper is dependency-injected so it can be exercised against fakes; the
 * production wiring (`createRunLogArchiverFromRuntime`) binds it to Drizzle, the
 * storage provider, and the on-disk run-log tree.
 */

const TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GZIP_CONTENT_TYPE = "application/gzip";

/**
 * Cap on failed archive attempts per sweep. Failures do NOT consume the
 * per-sweep itemLimit budget (so a burst of failures can't starve the age
 * pass), but we still bound them here so a persistently-stuck row cannot make
 * the sweep hot-loop over the same rows indefinitely.
 */
const MAX_ARCHIVE_FAILURES_PER_SWEEP = 25;

/** A heartbeat run row projected down to just what the archiver reasons about. */
export interface HeartbeatRunLogRow {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  finishedAt: Date | null;
  logStore: string | null;
  logRef: string | null;
}

/** DB port: only terminal, still-local runs are ever returned. */
export interface RunLogArchiverDb {
  /** Terminal `local_file` runs whose completion time is older than `cutoff`, oldest first. */
  selectAgeArchivable(cutoff: Date, limit: number): Promise<HeartbeatRunLogRow[]>;
  /** Terminal `local_file` runs for one company, oldest first (ignores the age gate). */
  selectCompanyArchivableOldestFirst(companyId: string, limit: number): Promise<HeartbeatRunLogRow[]>;
  /**
   * Conditionally flip a run's tier pointer to `s3` and repoint its logRef at
   * the object key — ONLY if the row is still `local_file`. Returns the number
   * of rows updated: 0 means another worker already moved it, so the caller
   * must NOT delete the local file.
   */
  markArchivedToS3(runId: string, objectKey: string, now: Date): Promise<number>;
  /**
   * Conditionally mark a run's log tier `missing` — ONLY if the row is still
   * `local_file`. Used when the hot file backing the row is definitively gone
   * (e.g. purged during an ENOSPC incident): the row would otherwise be
   * re-selected every sweep and burn the failure budget forever, stalling the
   * whole sweeper. `logRef` is left intact for forensics. Returns the affected-
   * row count (0 = another worker already moved it).
   */
  markMissing(runId: string, now: Date): Promise<number>;
}

/** Object-storage port (raw provider, system-scoped keys — not company-prefixed). */
export interface RunLogArchiverStorage {
  putObject(input: {
    objectKey: string;
    // Streamed (not buffered) so a large capped gz isn't held whole in RAM.
    body: Buffer | Readable;
    contentType: string;
    contentLength: number;
  }): Promise<void>;
  headObject(input: { objectKey: string }): Promise<{ exists: boolean; contentLength?: number }>;
}

/** Filesystem port over the on-disk run-log tree. */
export interface RunLogArchiverFs {
  /** Resolve + ensure-gzipped the local file for a logRef, ready to upload. */
  prepareArchiveSource(logRef: string): Promise<RunLogArchiveSource>;
  /** Unlink an uploaded file and prune now-empty agent/company dirs (best-effort). */
  removeArchivedFile(absPath: string): Promise<void>;
  /** Sum on-disk (compressed) run-log bytes per companyId by walking the base dir. */
  computeCompanyHotBytes(): Promise<Map<string, number>>;
}

export interface RunLogArchiverConfig {
  mode: "auto" | "off" | "s3";
  /**
   * True when the archive leg has usable object storage: the app-wide provider
   * is s3 (`auto` mode) or forced `s3` mode has a bucket configured.
   */
  storageEnabled: boolean;
  hotRetentionDays: number;
  companyBudgetBytes: number;
  /** Max archive actions attempted per sweep (fairness + age combined). */
  itemLimit: number;
}

export interface RunLogArchiverDeps {
  db: RunLogArchiverDb;
  storage: RunLogArchiverStorage;
  files: RunLogArchiverFs;
  config: RunLogArchiverConfig;
  now: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface RunLogSweepResult {
  skipped: boolean;
  reason?: "mode_off" | "storage_unavailable" | "already_running";
  examined: number;
  ageArchived: number;
  fairnessArchived: number;
  /** Rows whose hot file was definitively gone → marked `missing` (not a failure). */
  missing: number;
  failed: number;
}

export interface RunLogArchiver {
  runSweep(): Promise<RunLogSweepResult>;
}

export function resolveRunLogArchiverConfig(config: Config): RunLogArchiverConfig {
  const storageEnabled =
    config.runLogArchiveMode === "s3"
      ? config.storageS3Bucket.trim().length > 0
      : config.storageProvider === "s3";
  return {
    mode: config.runLogArchiveMode,
    storageEnabled,
    hotRetentionDays: config.runLogHotRetentionDays,
    companyBudgetBytes: config.runLogCompanyBudgetBytes,
    itemLimit: config.runLogSweepItemLimit,
  };
}

export function createRunLogArchiver(deps: RunLogArchiverDeps): RunLogArchiver {
  const log = deps.log ?? logger;
  // Overlap guard: sweeps run on a timer and can be slow (many uploads). If the
  // previous sweep hasn't finished, a new tick must no-op rather than double-
  // archive rows or race the same files.
  let sweeping = false;

  /**
   * Definitively-gone signal: `prepareArchiveSource` throws `notFound`
   * (HttpError 404) when nothing backs the ref on disk. Anything else
   * (IO/perms/gzip failure) is transient and must be retried, not marked dead.
   */
  function isMissingFileError(err: unknown): boolean {
    return err instanceof HttpError && err.status === 404;
  }

  /** Mark a dead row `missing` so it leaves the candidate pool. true = handled. */
  async function markMissingSafe(row: HeartbeatRunLogRow): Promise<boolean> {
    try {
      // 0 or 1 rows both mean the row is no longer our local_file problem.
      await deps.db.markMissing(row.id, deps.now());
      return true;
    } catch (err) {
      log.warn({ err, runId: row.id }, "run-log archive: failed to mark row 'missing'; will retry");
      return false;
    }
  }

  /**
   * Archive a single run end-to-end: gzip-if-needed → upload → head-verify →
   * flip DB tier → delete local. NEVER throws: a single run must not abort the
   * sweep. Outcomes:
   *  - `archived`: uploaded + verified + row flipped to s3 (`freed` = bytes)
   *  - `missing`:  hot file definitively gone → row marked `missing` so it
   *                leaves the candidate pool; does NOT count as a failure
   *  - `failed`:   transient problem → row stays `local_file`, retried next sweep
   */
  async function archiveOne(
    row: HeartbeatRunLogRow,
  ): Promise<{ outcome: "archived" | "missing" | "failed"; freed: number }> {
    if (!row.logRef) {
      // A local_file row with no ref can never resolve — mark it missing so it
      // cannot stall the sweep. (Selection filters these out, but be safe.)
      return { outcome: (await markMissingSafe(row)) ? "missing" : "failed", freed: 0 };
    }

    let source: RunLogArchiveSource;
    try {
      source = await deps.files.prepareArchiveSource(row.logRef);
    } catch (err) {
      if (isMissingFileError(err)) {
        const marked = await markMissingSafe(row);
        log.warn(
          { runId: row.id, logRef: row.logRef },
          marked
            ? "run-log archive: hot file gone; marked row 'missing' so it leaves the sweep"
            : "run-log archive: hot file gone but mark failed; will retry next sweep",
        );
        return { outcome: marked ? "missing" : "failed", freed: 0 };
      }
      log.warn(
        { err, runId: row.id, logRef: row.logRef },
        "run-log archive: source prepare failed (transient); will retry next sweep",
      );
      return { outcome: "failed", freed: 0 };
    }

    try {
      // Stream the gz straight from disk instead of buffering it in RAM: a
      // capped run can still be hundreds of MB compressed if incompressible.
      // contentLength comes from prepareArchiveSource's stat, so S3 PutObject
      // gets the exact length it needs up front.
      await deps.storage.putObject({
        objectKey: source.objectKey,
        body: createReadStream(source.absPath),
        contentType: GZIP_CONTENT_TYPE,
        contentLength: source.bytes,
      });

      // Verify-before-delete: only trust the upload once HEAD confirms the
      // object exists AND its size matches the local gz byte-for-byte.
      const head = await deps.storage.headObject({ objectKey: source.objectKey });
      if (!head.exists || head.contentLength !== source.bytes) {
        log.warn(
          {
            runId: row.id,
            objectKey: source.objectKey,
            expectedBytes: source.bytes,
            headBytes: head.contentLength,
            headExists: head.exists,
          },
          "run-log archive: upload verification failed; keeping local copy",
        );
        return { outcome: "failed", freed: 0 };
      }

      // Conditional flip: only if the row is still local_file. If another
      // worker already moved it (0 rows updated), the local file is no longer
      // ours to delete — leave it for whoever now owns the row.
      const updated = await deps.db.markArchivedToS3(row.id, source.objectKey, deps.now());
      if (updated === 0) {
        log.warn(
          { runId: row.id, objectKey: source.objectKey },
          "run-log archive: row already moved by another worker; keeping local copy",
        );
        return { outcome: "failed", freed: 0 };
      }
      await deps.files.removeArchivedFile(source.absPath);
      log.info(
        { runId: row.id, companyId: row.companyId, objectKey: source.objectKey, bytes: source.bytes },
        "run-log archived to cold storage",
      );
      return { outcome: "archived", freed: source.bytes };
    } catch (err) {
      log.warn(
        { err, runId: row.id, logRef: row.logRef },
        "run-log archive: upload/flip failed; keeping local copy, will retry next sweep",
      );
      return { outcome: "failed", freed: 0 };
    }
  }

  async function runSweep(): Promise<RunLogSweepResult> {
    const result: RunLogSweepResult = {
      skipped: false,
      examined: 0,
      ageArchived: 0,
      fairnessArchived: 0,
      missing: 0,
      failed: 0,
    };

    if (sweeping) {
      result.skipped = true;
      result.reason = "already_running";
      log.info({}, "run-log archiver: sweep already in progress; skipping this tick");
      return result;
    }

    if (deps.config.mode === "off" || !deps.config.storageEnabled) {
      const reason = deps.config.mode === "off" ? "mode_off" : "storage_unavailable";
      result.skipped = true;
      result.reason = reason;
      log.info(
        { mode: deps.config.mode, storageEnabled: deps.config.storageEnabled, reason },
        "run-log archiver: archiving disabled; no-op sweep (hot files age out via infra janitor backstop)",
      );
      return result;
    }

    sweeping = true;
    try {
      // Budget of SUCCESSFUL archive actions for this whole sweep, shared across
      // both passes. Only successes consume it — a failed attempt must not eat
      // the budget (that would let a run of failures starve the age pass);
      // failures are bounded separately by MAX_ARCHIVE_FAILURES_PER_SWEEP.
      let budget = deps.config.itemLimit;
      const failureCapReached = () => result.failed >= MAX_ARCHIVE_FAILURES_PER_SWEEP;

      // ---- Fairness pass: over-budget companies first, ignoring the age gate. ----
      try {
        const companyBytes = await deps.files.computeCompanyHotBytes();
        for (const [companyId, initialBytes] of companyBytes) {
          if (budget <= 0 || failureCapReached()) break;
          if (initialBytes <= deps.config.companyBudgetBytes) continue;

          let bytes = initialBytes;
          const rows = await deps.db.selectCompanyArchivableOldestFirst(companyId, budget);
          for (const row of rows) {
            if (bytes <= deps.config.companyBudgetBytes || budget <= 0 || failureCapReached()) break;
            result.examined += 1;
            const r = await archiveOne(row);
            if (r.outcome === "archived") {
              bytes -= r.freed;
              budget -= 1;
              result.fairnessArchived += 1;
            } else if (r.outcome === "missing") {
              result.missing += 1;
            } else {
              result.failed += 1;
            }
          }
        }
      } catch (err) {
        log.error({ err }, "run-log archiver: fairness pass failed");
      }

      // ---- Age pass: terminal runs older than the hot-retention window. ----
      try {
        if (budget > 0 && !failureCapReached()) {
          const cutoff = new Date(deps.now().getTime() - deps.config.hotRetentionDays * MS_PER_DAY);
          const rows = await deps.db.selectAgeArchivable(cutoff, budget);
          for (const row of rows) {
            if (budget <= 0 || failureCapReached()) break;
            result.examined += 1;
            const r = await archiveOne(row);
            if (r.outcome === "archived") {
              budget -= 1;
              result.ageArchived += 1;
            } else if (r.outcome === "missing") {
              result.missing += 1;
            } else {
              result.failed += 1;
            }
          }
        }
      } catch (err) {
        log.error({ err }, "run-log archiver: age pass failed");
      }

      if (failureCapReached()) {
        log.warn(
          { failed: result.failed },
          "run-log archiver: failure cap reached; ending sweep early to avoid hot-looping",
        );
      }

      if (
        result.ageArchived > 0 ||
        result.fairnessArchived > 0 ||
        result.missing > 0 ||
        result.failed > 0
      ) {
        log.info(
          { ...result },
          "run-log archiver sweep complete",
        );
      }
      return result;
    } finally {
      sweeping = false;
    }
  }

  return { runSweep };
}

// ---------------------------------------------------------------------------
// Production adapters
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createDb>;

/** Drizzle-backed DB port. Only ever selects terminal, `local_file` runs. */
export function createDrizzleRunLogArchiverDb(db: Db): RunLogArchiverDb {
  const columns = {
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    finishedAt: heartbeatRuns.finishedAt,
    logStore: heartbeatRuns.logStore,
    logRef: heartbeatRuns.logRef,
  } as const;

  // Completion time: finishedAt is set when a run reaches a terminal status, so
  // it is the authoritative "how old is this run" signal. Fall back to
  // updatedAt only if finishedAt is somehow null on a terminal row.
  const completedAt = sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`;

  return {
    selectAgeArchivable(cutoff, limit) {
      // postgres-js binds raw `sql` template parameters without Drizzle's
      // column-aware serialization (that only applies to typed column values,
      // e.g. `.set({ updatedAt: now })`). Handing it a bare `Date` here fails
      // at bind time ("argument must be of type string ... Received an
      // instance of Date") because postgres-js has no type/OID context to
      // encode it. Cast an ISO string instead — the same pattern already used
      // for heartbeatRuns timestamp comparisons in issues.ts.
      const cutoffIso = cutoff.toISOString();
      return db
        .select(columns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.logStore, "local_file"),
            isNotNull(heartbeatRuns.logRef),
            inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
            sql`${completedAt} < ${cutoffIso}::timestamptz`,
          ),
        )
        .orderBy(asc(completedAt))
        .limit(limit);
    },

    selectCompanyArchivableOldestFirst(companyId, limit) {
      return db
        .select(columns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.logStore, "local_file"),
            isNotNull(heartbeatRuns.logRef),
            inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
          ),
        )
        .orderBy(asc(completedAt))
        .limit(limit);
    },

    async markArchivedToS3(runId, objectKey, now) {
      // Conditional on the row still being local_file: `.returning()` yields one
      // row per update, so its length is the affected-row count. 0 means another
      // worker already flipped it → caller keeps its hands off the local file.
      const updated = await db
        .update(heartbeatRuns)
        .set({ logStore: "s3", logRef: objectKey, updatedAt: now })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.logStore, "local_file")))
        .returning({ id: heartbeatRuns.id });
      return updated.length;
    },

    async markMissing(runId, now) {
      // Conditional on the row still being local_file (mirrors markArchivedToS3).
      // logRef is intentionally left untouched so a purged run is still traceable.
      const updated = await db
        .update(heartbeatRuns)
        .set({ logStore: "missing", updatedAt: now })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.logStore, "local_file")))
        .returning({ id: heartbeatRuns.id });
      return updated.length;
    },
  };
}

/** Filesystem port over the real run-log tree at `baseDir`. */
export function createNodeRunLogArchiverFs(baseDir: string): RunLogArchiverFs {
  async function pruneEmptyParents(absPath: string): Promise<void> {
    // Walk up (agent dir, then company dir), rmdir while empty, never past baseDir.
    let dir = path.dirname(absPath);
    const stop = path.resolve(baseDir);
    while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        // Non-empty or already gone: stop climbing.
        break;
      }
      dir = path.dirname(dir);
    }
  }

  return {
    prepareArchiveSource: (logRef) => prepareRunLogArchiveSource(baseDir, logRef),

    async removeArchivedFile(absPath) {
      await fs.unlink(absPath).catch(() => undefined);
      // If we archived a legacy raw file, the compressed sibling was created in
      // place — try to drop a stray raw sibling too.
      if (absPath.endsWith(".gz")) {
        await fs.unlink(absPath.slice(0, -".gz".length)).catch(() => undefined);
      }
      await pruneEmptyParents(absPath);
    },

    async computeCompanyHotBytes() {
      const totals = new Map<string, number>();
      const companyDirs = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
      for (const companyEntry of companyDirs) {
        if (!companyEntry.isDirectory()) continue;
        const companyId = companyEntry.name;
        const companyDir = path.join(baseDir, companyId);
        let sum = 0;
        const agentDirs = await fs.readdir(companyDir, { withFileTypes: true }).catch(() => []);
        for (const agentEntry of agentDirs) {
          if (!agentEntry.isDirectory()) continue;
          const agentDir = path.join(companyDir, agentEntry.name);
          const files = await fs.readdir(agentDir, { withFileTypes: true }).catch(() => []);
          for (const fileEntry of files) {
            if (!fileEntry.isFile()) continue;
            const stat = await fs.stat(path.join(agentDir, fileEntry.name)).catch(() => null);
            if (stat) sum += stat.size;
          }
        }
        totals.set(companyId, sum);
      }
      return totals;
    },
  };
}

/** Wrap the raw {@link getRunLogArchiveStorageProvider} into the archiver's storage port. */
export function createProviderRunLogArchiverStorage(): RunLogArchiverStorage {
  return {
    putObject: (input) => getRunLogArchiveStorageProvider().putObject(input),
    async headObject(input) {
      const head = await getRunLogArchiveStorageProvider().headObject({ objectKey: input.objectKey });
      return { exists: head.exists, contentLength: head.contentLength };
    },
  };
}

/** Production wiring: bind the archiver to Drizzle, the storage provider, and disk. */
export function createRunLogArchiverFromRuntime(db: Db, config: Config): RunLogArchiver {
  const baseDir = resolveRunLogBasePath();
  return createRunLogArchiver({
    db: createDrizzleRunLogArchiverDb(db),
    storage: createProviderRunLogArchiverStorage(),
    files: createNodeRunLogArchiverFs(baseDir),
    config: resolveRunLogArchiverConfig(config),
    now: () => new Date(),
  });
}
