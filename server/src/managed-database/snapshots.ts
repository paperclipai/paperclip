import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import {
  MANAGED_DATABASE_SNAPSHOT_FORMAT,
  type ManagedDatabaseSnapshotReceiptDetails,
} from "@paperclipai/shared/managed-database";
import { SUPERVISOR_ROLE, supervisorSql } from "./engine.js";
import { fsyncDirectory, fsyncFile, readJsonIfExists, writeJsonAtomic, type ManagedDatabaseLayout } from "./layout.js";

export type ClusterAccess = {
  socketDir: string;
  port: number;
  superuserPassword: string;
};

export type PgClientTools = {
  binDir: string;
  version: string;
  major: number;
};

type Sql = ReturnType<typeof postgres>;

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], cwd: "/" });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-32_768); });
  child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-32_768); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${path.basename(command)} exited ${code}: ${output.trim()}`);
  return output;
}

/**
 * pg_dump/pg_restore must match the pinned engine major. The image installs
 * them from PGDG at /usr/lib/postgresql/<major>/bin.
 */
export async function resolvePgClientTools(engineMajor: number, env: NodeJS.ProcessEnv = process.env): Promise<PgClientTools | null> {
  const candidates = [
    env.PAPERCLIP_MANAGED_DATABASE_PG_CLIENT_BIN_DIR,
    `/usr/lib/postgresql/${engineMajor}/bin`,
  ].filter((value): value is string => Boolean(value));
  for (const binDir of candidates) {
    if (!existsSync(path.join(binDir, "pg_dump")) || !existsSync(path.join(binDir, "pg_restore"))) continue;
    try {
      const output = await run(path.join(binDir, "pg_dump"), ["--version"], { PATH: process.env.PATH ?? "/usr/bin:/bin" });
      const match = output.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
      if (!match) continue;
      const major = Number(match[1]);
      if (major !== engineMajor) continue;
      return { binDir, version: match[2] ? `${match[1]}.${match[2]}` : match[1]!, major };
    } catch {
      continue;
    }
  }
  return null;
}

function libpqEnv(access: ClusterAccess): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PGPASSWORD: access.superuserPassword,
    PGCONNECT_TIMEOUT: "10",
    LANG: "C",
    LC_ALL: "C",
  };
}

function conninfo(access: ClusterAccess, database: string): string {
  return `host=${access.socketDir} port=${access.port} user=${SUPERVISOR_ROLE} dbname=${database}`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type JournalFingerprint = ManagedDatabaseSnapshotReceiptDetails["journal"];

/** Fingerprint of the applied migration journal, from the database itself. */
export async function readJournalFingerprint(sql: Sql, latestApplied: string | null): Promise<JournalFingerprint> {
  const [located] = await sql<{ table: string | null }[]>`
    select coalesce(to_regclass('drizzle.__drizzle_migrations'), to_regclass('public.__drizzle_migrations'))::text as table
  `;
  const hash = createHash("sha256");
  if (!located?.table) return { entries: 0, digest: hash.update("empty").digest("hex"), latestApplied };
  const rows = await sql.unsafe<{ hash: string | null; created_at: string | null }[]>(
    `select hash, created_at::text as created_at from ${located.table} order by id`,
  );
  for (const row of rows) hash.update(`${row.hash ?? ""}:${row.created_at ?? ""}\n`);
  return { entries: rows.length, digest: hash.digest("hex"), latestApplied };
}

/** Exact row counts for every ordinary table in non-system schemas. */
export async function readTableRowCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
    order by 1, 2
  `;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await sql.unsafe<{ count: string }[]>(
      `select count(*)::text as count from ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`,
    );
    counts[`${table.schema}.${table.name}`] = Number(row?.count ?? 0);
  }
  return counts;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function snapshotPaths(layout: ManagedDatabaseLayout, snapshotId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(snapshotId) || snapshotId.includes("..")) {
    throw new Error(`invalid snapshot id ${snapshotId}`);
  }
  const base = path.join(layout.snapshotsDir, snapshotId.replace(/:/g, "_"));
  return { archive: `${base}.dump`, metadata: `${base}.json`, partial: `${base}.dump.partial` };
}

/**
 * Make a durable archive visible: metadata first, then the archive rename.
 * A snapshot exists only once its archive is in place, so a crash in between
 * leaves stray metadata that boot cleanup removes, never an archive without
 * its details.
 */
export function publishSnapshot(
  layout: ManagedDatabaseLayout,
  paths: ReturnType<typeof snapshotPaths>,
  details: ManagedDatabaseSnapshotReceiptDetails,
  durableFile: string,
): void {
  writeJsonAtomic(paths.metadata, details);
  renameSync(durableFile, paths.archive);
  fsyncDirectory(layout.snapshotsDir);
}

export function readSnapshotDetails(layout: ManagedDatabaseLayout, snapshotId: string): ManagedDatabaseSnapshotReceiptDetails | null {
  const paths = snapshotPaths(layout, snapshotId);
  if (!existsSync(paths.archive)) return null;
  return readJsonIfExists<ManagedDatabaseSnapshotReceiptDetails>(paths.metadata);
}

export function listSnapshots(layout: ManagedDatabaseLayout): string[] {
  if (!existsSync(layout.snapshotsDir)) return [];
  return readdirSync(layout.snapshotsDir).filter((name) => name.endsWith(".dump")).map((name) => name.slice(0, -5)).sort();
}

export type SnapshotIdentity = Pick<
  ManagedDatabaseSnapshotReceiptDetails,
  "stackId" | "volumeId" | "systemIdentifier" | "engineVersion" | "engineMajor"
>;

/**
 * Database-only logical archive of the tenant database. Row counts and the
 * journal fingerprint come from the same exported snapshot pg_dump uses, so
 * the receipt describes exactly what the archive contains even while online.
 */
export async function createSnapshot(opts: {
  access: ClusterAccess;
  tools: PgClientTools;
  layout: ManagedDatabaseLayout;
  database: string;
  snapshotId: string;
  consistency: "quiesced" | "online";
  identity: SnapshotIdentity;
  latestApplied: string | null;
}): Promise<ManagedDatabaseSnapshotReceiptDetails> {
  const paths = snapshotPaths(opts.layout, opts.snapshotId);
  if (existsSync(paths.archive)) throw new Error(`snapshot ${opts.snapshotId} already exists`);
  rmSync(paths.partial, { force: true });

  const sql = supervisorSql(opts.access, opts.database);
  const conn = await sql.reserve();
  try {
    await conn.unsafe("begin isolation level repeatable read read only");
    const [exported] = await conn<{ id: string }[]>`select pg_export_snapshot() as id`;
    const tableRowCounts = await readTableRowCounts(conn as unknown as Sql);
    const journal = await readJournalFingerprint(conn as unknown as Sql, opts.latestApplied);
    await run(path.join(opts.tools.binDir, "pg_dump"), [
      "--format=custom",
      `--snapshot=${exported!.id}`,
      `--file=${paths.partial}`,
      `--dbname=${conninfo(opts.access, opts.database)}`,
    ], libpqEnv(opts.access));
    await conn.unsafe("commit");

    fsyncFile(paths.partial);
    const sha256 = await sha256File(paths.partial);
    const sizeBytes = statSync(paths.partial).size;
    const details: ManagedDatabaseSnapshotReceiptDetails = {
      snapshotId: opts.snapshotId,
      format: MANAGED_DATABASE_SNAPSHOT_FORMAT,
      consistency: opts.consistency,
      sha256,
      sizeBytes,
      ...opts.identity,
      database: opts.database,
      journal,
      tableRowCounts,
      createdAt: new Date().toISOString(),
    };
    publishSnapshot(opts.layout, paths, details, paths.partial);
    return details;
  } catch (error) {
    await conn.unsafe("rollback").catch(() => {});
    rmSync(paths.partial, { force: true });
    throw error;
  } finally {
    conn.release();
    await sql.end({ timeout: 2 });
  }
}

export type RestoreIntent = {
  v: 1;
  restoreId: string;
  snapshotId: string;
  commandId: string;
  staging: string;
  retained: string;
  phase: "staging" | "verified" | "swapped";
};

export class SnapshotVerificationError extends Error {}

/**
 * Restore into a staging database, verify it against the receipt, then swap
 * it in by renaming. The previous database is retained for diagnosis. The
 * intent file lets a restarted supervisor finish or discard a swap that was
 * interrupted between the two renames.
 */
export async function restoreSnapshot(opts: {
  access: ClusterAccess;
  tools: PgClientTools;
  layout: ManagedDatabaseLayout;
  database: string;
  details: ManagedDatabaseSnapshotReceiptDetails;
  restoreId: string;
  commandId: string;
  /** Re-checked immediately before the swap (lease fencing). */
  beforeSwap: () => void;
}): Promise<{ retained: string; verifiedTables: number }> {
  const paths = snapshotPaths(opts.layout, opts.details.snapshotId);
  const actualSha = await sha256File(paths.archive);
  if (actualSha !== opts.details.sha256) {
    throw new SnapshotVerificationError(`archive sha256 ${actualSha} does not match receipt ${opts.details.sha256}`);
  }
  const staging = `paperclip_restore_${opts.restoreId}`;
  const retained = `paperclip_pre_restore_${opts.restoreId}`;
  const intent: RestoreIntent = {
    v: 1, restoreId: opts.restoreId, snapshotId: opts.details.snapshotId, commandId: opts.commandId,
    staging, retained, phase: "staging",
  };
  writeJsonAtomic(opts.layout.restoreIntentFile, intent);

  const admin = supervisorSql(opts.access, "postgres");
  try {
    await admin.unsafe(`drop database if exists ${staging}`);
    await admin.unsafe(`create database ${staging} owner paperclip_owner encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    await run(path.join(opts.tools.binDir, "pg_restore"), [
      "--exit-on-error",
      "--single-transaction",
      `--dbname=${conninfo(opts.access, staging)}`,
      paths.archive,
    ], libpqEnv(opts.access));

    const stagingSql = supervisorSql(opts.access, staging);
    try {
      const counts = await readTableRowCounts(stagingSql);
      const expected = opts.details.tableRowCounts;
      const mismatches = [...new Set([...Object.keys(expected), ...Object.keys(counts)])]
        .filter((key) => expected[key] !== counts[key])
        .map((key) => `${key}: expected ${expected[key] ?? "absent"}, restored ${counts[key] ?? "absent"}`);
      if (mismatches.length > 0) {
        throw new SnapshotVerificationError(`restored row counts differ: ${mismatches.slice(0, 5).join("; ")}`);
      }
      const journal = await readJournalFingerprint(stagingSql, opts.details.journal.latestApplied);
      if (journal.digest !== opts.details.journal.digest || journal.entries !== opts.details.journal.entries) {
        throw new SnapshotVerificationError("restored migration journal does not match the receipt");
      }
    } finally {
      await stagingSql.end({ timeout: 2 });
    }
    writeJsonAtomic(opts.layout.restoreIntentFile, { ...intent, phase: "verified" } satisfies RestoreIntent);

    opts.beforeSwap();
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${opts.database} and pid <> pg_backend_pid()
    `;
    await admin.unsafe(`alter database ${opts.database} rename to ${retained}`);
    await admin.unsafe(`alter database ${staging} rename to ${opts.database}`);
    writeJsonAtomic(opts.layout.restoreIntentFile, { ...intent, phase: "swapped" } satisfies RestoreIntent);
    return { retained, verifiedTables: Object.keys(opts.details.tableRowCounts).length };
  } catch (error) {
    const current = readJsonIfExists<RestoreIntent>(opts.layout.restoreIntentFile);
    if (current?.phase !== "swapped") {
      // Never leave the stack without its database: undo a half swap.
      const names = await listDatabases(admin).catch(() => [] as string[]);
      if (!names.includes(opts.database) && names.includes(retained)) {
        await admin.unsafe(`alter database ${retained} rename to ${opts.database}`).catch(() => {});
      }
      await admin.unsafe(`drop database if exists ${staging}`).catch(() => {});
      rmSync(opts.layout.restoreIntentFile, { force: true });
    }
    throw error;
  } finally {
    await admin.end({ timeout: 2 });
  }
}

export async function listDatabases(admin: Sql): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`select datname from pg_database where not datistemplate`;
  return rows.map((row) => row.datname);
}

/**
 * Boot-time reconciliation of an interrupted restore. Returns a description
 * of what was resolved, or null when there was nothing to do. The intent file
 * stays in place: the caller removes it after its own bookkeeping (grants and
 * the recovery hold), and running this again reaches the same outcome.
 */
export async function reconcileRestoreIntent(opts: {
  access: ClusterAccess;
  layout: ManagedDatabaseLayout;
  database: string;
}): Promise<{ outcome: "completed" | "rolled_back"; intent: RestoreIntent } | null> {
  const intent = readJsonIfExists<RestoreIntent>(opts.layout.restoreIntentFile);
  if (!intent) return null;
  const admin = supervisorSql(opts.access, "postgres");
  try {
    const names = await listDatabases(admin);
    const has = (name: string) => names.includes(name);
    let outcome: "completed" | "rolled_back";
    if (intent.phase === "swapped") {
      outcome = "completed";
    } else if (intent.phase === "verified" && !has(opts.database) && has(intent.staging) && has(intent.retained)) {
      // Interrupted between the two renames after verification: finish forward.
      await admin.unsafe(`alter database ${intent.staging} rename to ${opts.database}`);
      outcome = "completed";
    } else if (intent.phase === "verified" && has(opts.database) && has(intent.retained) && !has(intent.staging)) {
      // Both renames landed; only the intent update was lost.
      outcome = "completed";
    } else {
      if (!has(opts.database) && has(intent.retained)) {
        await admin.unsafe(`alter database ${intent.retained} rename to ${opts.database}`);
      }
      if (has(intent.staging)) await admin.unsafe(`drop database if exists ${intent.staging}`);
      outcome = "rolled_back";
    }
    return { outcome, intent };
  } finally {
    await admin.end({ timeout: 2 });
  }
}
