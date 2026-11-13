import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import { promises as fs } from "node:fs";
import { applyPendingMigrations, createDb, inspectMigrations } from "../packages/db/src/index.js";

const host = { availableCpus: availableParallelism(), loadBefore: loadavg() };
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const connectionString = process.env.TASK_PROJECTION_MIGRATION_URL;
assert.ok(connectionString, "Set TASK_PROJECTION_MIGRATION_URL to an isolated pre-migration database");
const url = new URL(connectionString);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.match(url.pathname, /^\/task_projection_[a-z0-9_]+$/);
const db = createDb(connectionString, { maxConnections: 1 });
const writer = createDb(connectionString, { maxConnections: 1 });
const reader = createDb(connectionString, { maxConnections: 1 });
const indexName = "activity_log_company_entity_created_idx";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const indexState = () => db.$client.unsafe("select i.indisvalid,i.indisready,pg_relation_size(c.oid)::text bytes from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname=$1", [indexName]);
const keepAlive = setInterval(() => {}, 1000);
try {
  await writer.$client.unsafe("select 1");
  await reader.$client.unsafe("select 1");
  const before = await inspectMigrations(connectionString);
  assert.equal(before.pendingMigrations.length, 1, "Only the activity index migration may be pending");
  assert.equal((await indexState()).length, 0, "Start without the index");
  const sizes = await db.$client.unsafe("select c.relname,c.reltuples::bigint estimated_rows,pg_relation_size(c.oid)::text heap_bytes,pg_total_relation_size(c.oid)::text total_bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('issues','activity_log','issue_comments','heartbeat_runs','agent_wakeup_requests') order by c.relname");
  const settings = await db.$client.unsafe("select version(),current_setting('work_mem') work_mem,current_setting('maintenance_work_mem') maintenance_work_mem,current_setting('max_parallel_maintenance_workers') max_parallel_maintenance_workers");
  const progress = async () => db.$client.unsafe("select pid,phase,blocks_total,blocks_done from pg_stat_progress_create_index where datname=current_database() and relid='activity_log'::regclass");
  let cancellation: unknown;
  if (!process.argv.includes("--skip-cancel")) {
    const cancelStart = performance.now();
    let cancelledFinished = false;
    const cancelledRun = applyPendingMigrations(connectionString).then(() => ({ completed: true }), error => ({ code: error.code, message: error.message })).finally(() => { cancelledFinished = true; });
    let cancellationProgress: unknown;
    while (!cancelledFinished) {
      const rows = await progress();
      if (rows[0]?.phase.startsWith("building index:") && Number(rows[0]?.blocks_done) > 100) {
        cancellationProgress = rows[0];
        assert.equal((await db.$client.unsafe("select pg_cancel_backend($1) cancelled", [rows[0]!.pid]))[0]!.cancelled, true);
        break;
      }
      await pause();
    }
    const result = await cancelledRun;
    const invalidIndex = await indexState();
    cancellation = { result, progress: cancellationProgress, totalMs: performance.now() - cancelStart, invalidIndex };
    assert.equal((result as { code?: string }).code, "57014", "Cancel the actual index build");
    assert.equal(invalidIndex[0]?.indisvalid, false, "Cancelled concurrent build must leave an invalid index for the runner to repair");
    assert.deepEqual((await inspectMigrations(connectionString)).pendingMigrations, before.pendingMigrations, "Cancelled build must not be journaled");
  }
  const [sample] = await db.$client.unsafe("select company_id,entity_id from activity_log where entity_type='issue' limit 1");
  assert.ok(sample);
  const insert = () => writer.$client.unsafe("insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details) values($1,'issue',$2,'system','migration-probe','benchmark.migration_probe','{}') returning id", [sample.company_id, sample.entity_id]);
  const buildStart = performance.now();
  let finished = false;
  const build = applyPendingMigrations(connectionString).finally(() => { finished = true; });
  let buildProgress: unknown;
  let writeStart = 0;
  let writeMs: number | undefined;
  let readMs: number | undefined;
  let insertedId: string | undefined;
  let concurrent: Promise<unknown> | undefined;
  while (!finished) {
    const rows = await progress();
    if (rows.length) {
      buildProgress = rows[0];
      writeStart = performance.now();
      concurrent = insert().then(rows => { writeMs = performance.now() - writeStart; insertedId = rows[0]!.id; });
      const readStart = performance.now();
      await reader.$client.unsafe("select id from activity_log where company_id=$1 order by created_at desc limit 20", [sample.company_id]);
      readMs = performance.now() - readStart;
      break;
    }
    await pause();
  }
  await build;
  const buildMs = performance.now() - buildStart;
  await concurrent;
  assert.ok(buildProgress, "Observe the build while ordinary readers and writers run");
  assert.equal((await inspectMigrations(connectionString)).status, "upToDate");
  assert.equal((await indexState())[0]!.indisvalid, true);
  if (insertedId) await writer.$client.unsafe("delete from activity_log where id=$1", [insertedId]);
  const retryStart = performance.now();
  await applyPendingMigrations(connectionString);
  const retryMs = performance.now() - retryStart;
  const report = { host: { ...host, loadAfter: loadavg() }, settings, beforePending: before.pendingMigrations, sizes, cancellation, successfulBuild: { totalMs: buildMs, progress: buildProgress, concurrentWriteMs: writeMs, concurrentReadMs: readMs }, appliedRerunMs: retryMs, index: await indexState() };
  if (arg("output")) await fs.writeFile(arg("output")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(keepAlive);
  await reader.$client.end({ timeout: 0 });
  await writer.$client.end({ timeout: 0 });
  await db.$client.end({ timeout: 0 });
}
