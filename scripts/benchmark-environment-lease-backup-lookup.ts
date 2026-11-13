/**
 * Local proof for the native backup lease lookup (migration 0459).
 *
 * `reconcileBackup` reads the leases that reference one backup root: the
 * session's run leases, leases whose `metadata.nativeHarnessBackup` stamp has
 * the root's scope digest, and the identity's own lease. The metadata arm had
 * no index, so PostgreSQL read every lease of the company and its metadata.
 *
 * The script captures the SQL that the real service generates, then measures
 * it without and with the new index (no index, index, no index again). It
 * fails unless the service's lease IDs and the complete query rows match.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-environment-lease-backup-lookup.ts
 *
 * Optional sizes: LEASES (default 100000), STAMPED_PERCENT (30),
 * METADATA_KIB (4), OTHER_COMPANY_LEASES (20000).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { nativeHarnessBackupExpirationService } from "../server/src/services/native-runtime/native-harness-backup-expiration.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const LEASES = size("LEASES", 100_000), STAMPED_PERCENT = size("STAMPED_PERCENT", 30);
const METADATA_KIB = size("METADATA_KIB", 4), OTHER_COMPANY_LEASES = size("OTHER_COMPANY_LEASES", 20_000);
const migration = readFileSync(process.env.INDEX_SQL_FILE ?? new URL(
  "../packages/db/src/migrations/0459_environment_lease_backup_scope_index.sql", import.meta.url), "utf8");
const indexStatements = migration.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const indexNames = indexStatements.map(statement => statement.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!);

type Captured = { sql: string; params: unknown[] };
/** Records the SQL of each `db.select(...).from(...)` the service awaits. */
function capture(db: Db, queries: Captured[]): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args), then = selection.then.bind(selection);
        selection.then = ((...handlers: Parameters<typeof then>) => {
          queries.push(selection.toSQL());
          return then(...handlers);
        }) as typeof selection.then;
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
}

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let stateBase: string | undefined;
try {
  temporary = await startEmbeddedPostgresTestDatabase("environment-lease-backup-lookup-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  for (const name of indexNames) await sql.unsafe(`DROP INDEX IF EXISTS "${name}"`);
  await sql.unsafe("create extension if not exists pgcrypto");

  const companyId = randomUUID(), otherCompanyId = randomUUID();
  await db.insert(companies).values([{ id: companyId, name: "Leases", issuePrefix: "LEA" },
    { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
  const [agent] = await db.insert(agents).values({ companyId, name: "Coder" }).returning();
  const sessionId = randomUUID();
  // Three runs of the backed-up session; the root's identity names the first.
  const runs = await db.insert(heartbeatRuns).values([0, 1, 2].map(() => ({
    companyId, agentId: agent!.id, status: "succeeded", nativeSessionId: sessionId }))).returning();
  const scope = createHash("sha256").update(randomUUID()).digest("hex");

  const loadStart = performance.now();
  // History: incompressible sandbox metadata; some leases carry another
  // session's backup stamp, most carry none.
  const seed = (company: string, count: number) => sql.unsafe(`insert into environment_leases
      (company_id, status, lease_policy, provider, provider_lease_id, metadata, created_at, last_used_at)
    select $1::uuid, case when g % 10 = 0 then 'active' else 'released' end, 'retain_on_failure', 'sandbox',
      'sbx-' || g, jsonb_build_object(
        'nativeHarnessBackup', case when g % 100 < $2::int then jsonb_build_object(
          'sessionScopeSha256', encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
          'manifestSha256', encode(digest(g::text, 'sha256'), 'hex')) end,
        'sandbox', (select string_agg(encode(gen_random_bytes(768), 'base64'), '') from generate_series(1, $3::int) s(i) where g > 0)),
      now() - make_interval(secs => g), now() - make_interval(secs => g)
    from generate_series(1, $4::int) g`, [company, STAMPED_PERCENT, METADATA_KIB, count]);
  await seed(companyId, LEASES);
  await seed(otherCompanyId, OTHER_COMPANY_LEASES);
  // References to the root: a lease of each run; one lease known only by its
  // backup stamp (its run row was deleted); the identity's own lease; and the
  // same digest in another company, which must stay out.
  const runLeases = await db.insert(environmentLeases).values(runs.map(run => ({
    companyId, heartbeatRunId: run.id, status: "released", metadata: { sandbox: "run" } }))).returning();
  const [stamped] = await db.insert(environmentLeases).values({ companyId, status: "retained",
    metadata: { nativeHarnessBackup: { sessionScopeSha256: scope } } }).returning();
  const [own] = await db.insert(environmentLeases).values({ companyId, status: "active", metadata: {} }).returning();
  await db.insert(environmentLeases).values({ companyId: otherCompanyId, status: "retained",
    metadata: { nativeHarnessBackup: { sessionScopeSha256: scope } } });
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const expectedLeaseIds = [...runLeases.map(lease => lease.id), stamped!.id, own!.id].sort();

  stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "environment-lease-backup-lookup-"));
  const root = path.join(stateBase, scope);
  await fs.mkdir(path.join(root, "control-plane"), { recursive: true });
  await fs.mkdir(path.join(root, "failover-backups", "current"), { recursive: true });
  await fs.writeFile(path.join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
    identity: { runId: runs[0]!.id, normalizedSessionId: sessionId, environmentLeaseId: own!.id } }));
  const service = (target: Db) => nativeHarnessBackupExpirationService(target, {
    stateBase, closedForDays: 7, isSessionBusy: () => false });

  const queries: Captured[] = [];
  const reconciled = await service(capture(db, queries)).reconcileBackup(scope);
  assert.deepEqual([...reconciled!.dependencies.leaseIds].sort(), expectedLeaseIds);
  const leaseQuery = queries.find(query => query.sql.includes('from "environment_leases"') && query.sql.includes("sessionScopeSha256"));
  assert.ok(leaseQuery, "The service must read the root's leases");

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const round = (value: number) => Number(value.toFixed(3));
  const summary = (samples: number[]) => ({ samplesMs: samples.map(round), medianMs: round(median(samples)),
    minMs: round(Math.min(...samples)), maxMs: round(Math.max(...samples)) });
  async function explain() {
    const [result] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${leaseQuery!.sql}`, leaseQuery!.params as never[]);
    return (result!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>)[0]!;
  }
  function nodes(plan: Record<string, unknown>, out: string[] = []) {
    out.push(`${plan["Node Type"]}${plan["Index Name"] ? ` using ${plan["Index Name"]}` : ""}`);
    for (const child of (plan.Plans as Array<Record<string, unknown>> | undefined) ?? []) nodes(child, out);
    return out;
  }
  async function measure(indexed: boolean) {
    const builds: Array<{ index: string; ms: number }> = [];
    if (!indexed) for (const name of indexNames) await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    else for (const [n, statement] of indexStatements.entries()) {
      const start = performance.now();
      await sql.unsafe(statement);
      builds.push({ index: indexNames[n]!, ms: Math.round(performance.now() - start) });
    }
    await sql.unsafe("analyze environment_leases");
    const rows = (await sql.unsafe(leaseQuery!.sql, leaseQuery!.params as never[]).values())
      .map(row => row.map(value => value?.toString() ?? null)).sort();
    const ids = [...(await service(db!).reconcileBackup(scope))!.dependencies.leaseIds].sort();
    for (let n = 0; n < 2; n++) await explain();
    const execution: number[] = [], wall: number[] = [];
    for (let n = 0; n < 11; n++) {
      execution.push((await explain())["Execution Time"]);
      const start = performance.now();
      await service(db!).reconcileBackup(scope);
      wall.push(performance.now() - start);
    }
    const plan = (await explain()).Plan;
    return { indexed, builds, rows, ids, serverExecution: summary(execution), reconcileBackupWall: summary(wall),
      plan: { nodes: nodes(plan), sharedHitBlocks: plan["Shared Hit Blocks"], sharedReadBlocks: plan["Shared Read Blocks"] } };
  }

  const results = [await measure(false), await measure(true), await measure(false), await measure(true)];
  for (const result of results) {
    assert.deepEqual(result.ids, expectedLeaseIds, "Service lease IDs must match");
    assert.deepEqual(result.rows, results[0]!.rows, "Complete query rows must match");
  }
  console.log(JSON.stringify({
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    settings: await sql.unsafe("select name, setting from pg_settings where name in ('shared_buffers','work_mem','jit') order by name"),
    fixture: { synthetic: true, leases: LEASES, stampedPercent: STAMPED_PERCENT, metadataKiB: METADATA_KIB,
      otherCompanyLeases: OTHER_COMPANY_LEASES, loadMs: Math.round(loadMs),
      tableSize: (await sql.unsafe("select pg_size_pretty(pg_total_relation_size('environment_leases')) as size"))[0]!.size,
      indexSizes: await sql.unsafe(`select c.relname, pg_size_pretty(pg_relation_size(c.oid)) as size from pg_class c
        where c.relname in (${indexNames.map((_, n) => `$${n + 1}`).join(", ")})`, indexNames) },
    statement: leaseQuery.sql,
    correctness: { serviceLeaseIdsEqual: true, completeRowsEqual: true, matchedLeases: expectedLeaseIds.length,
      cases: ["run leases", "stamp-only lease", "identity lease", "same digest in another company excluded"] },
    results: results.map(({ rows: _rows, ids: _ids, ...result }) => result),
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
