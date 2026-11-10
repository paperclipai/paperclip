/**
 * Times migration 0458 through the normal migration runner on a large
 * synthetic chat_actions table, including a rerun after the history row is removed.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-chat-admission-index-migration.ts
 *
 * Optional sizes: OTHER_ACTIONS (default 300000), OTHER_PAYLOAD_KIB (4),
 * WAKEUPS (300000), WAKEUP_PAYLOAD_KIB (2).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { seedGitHubReviewWait } from "../server/src/__tests__/helpers/github-review-wait.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const OTHER_ACTIONS = size("OTHER_ACTIONS", 300_000), OTHER_PAYLOAD_KIB = size("OTHER_PAYLOAD_KIB", 4);
const WAKEUPS = size("WAKEUPS", 300_000), WAKEUP_PAYLOAD_KIB = size("WAKEUP_PAYLOAD_KIB", 2);
const migration = readFileSync(new URL("../packages/db/src/migrations/0458_chat_admission_issue_index.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migration).digest("hex");
const indexName = migration.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!;

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  temporary = await startEmbeddedPostgresTestDatabase("chat-admission-index-migration-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  await sql.unsafe(`DROP INDEX IF EXISTS "${indexName}"`);
  const { companyId, agentId, endpointId, conversationId } = await seedGitHubReviewWait(db);
  await sql.unsafe("create extension if not exists pgcrypto");
  const blob = (kib: string) => `(select string_agg(encode(gen_random_bytes(768), 'base64'), '')
    from generate_series(1, ${kib}) s(i) where g > 0)`;

  const loadStart = performance.now();
  await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, kind, provider_action_id, status, payload)
    select $1::uuid, $2::uuid, 'github_review_check', 'other-' || g, 'processed',
      jsonb_build_object('event', jsonb_build_object('body', ${blob("$3::int")}))
    from generate_series(1, $4::int) g`, [companyId, endpointId, OTHER_PAYLOAD_KIB, OTHER_ACTIONS]);
  await sql.unsafe(`insert into chat_actions (company_id, endpoint_id, conversation_id, kind, provider_action_id, status, payload)
    select $1::uuid, $2::uuid, $3::uuid, case when g % 50 = 0 then 'failed_run_retry' else 'inbound_wakeup' end,
      'wake-' || g, 'processed', jsonb_build_object('issueId', gen_random_uuid()::text, 'agentId', $4::text,
        'text', ${blob("$5::int")})
    from generate_series(1, $6::int) g`, [companyId, endpointId, conversationId, agentId, WAKEUP_PAYLOAD_KIB, WAKEUPS]);
  await sql.unsafe("vacuum analyze chat_actions");
  const loadMs = performance.now() - loadStart;
  const tableSizes = await sql.unsafe(`select relname as table, n_live_tup::bigint::text as rows,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_stat_user_tables
    where relname = 'chat_actions'`);

  async function migrate() {
    // Remove only this migration's history row (the runner records the file's sha256).
    await sql.unsafe("delete from drizzle.__drizzle_migrations where hash = $1", [migrationHash]);
    const start = performance.now();
    await applyPendingMigrations(temporary!.connectionString);
    return performance.now() - start;
  }
  // First run builds the index; the rerun finds it valid and skips it.
  const firstRunMs = await migrate();
  const valid = await sql.unsafe(`select c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) as size
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1`, [indexName]);
  assert.equal(valid.length, 1);
  assert.ok(valid[0]!.indisvalid);
  const rerunMs = await migrate();
  await sql.unsafe(`DROP INDEX CONCURRENTLY "${indexName}"`);
  const buildStart = performance.now();
  await sql.unsafe(migration.trim());
  const buildMs = performance.now() - buildStart;
  console.log(JSON.stringify({
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    fixture: { synthetic: true, otherActions: OTHER_ACTIONS, otherPayloadKiB: OTHER_PAYLOAD_KIB, wakeups: WAKEUPS,
      wakeupPayloadKiB: WAKEUP_PAYLOAD_KIB, loadMs: Math.round(loadMs), tableSizes },
    migration: { firstRunMs: Math.round(firstRunMs), rerunMs: Math.round(rerunMs), index: valid[0],
      concurrentBuildMs: Math.round(buildMs) },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  } finally { clearInterval(keepAlive); }
}
