/**
 * Times migration 0456 through the normal migration runner on a large
 * synthetic database, including a rerun after the history row is removed.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-review-lookup-index-migration.ts
 *
 * Optional sizes: RUNS (default 200000), RUN_CONTEXT_KIB (8), LINKS (500000),
 * DELIVERIES (100000).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { seedGitHubReviewWait } from "../server/src/__tests__/helpers/github-review-wait.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const RUNS = size("RUNS", 200_000), RUN_CONTEXT_KIB = size("RUN_CONTEXT_KIB", 8);
const LINKS = size("LINKS", 500_000), DELIVERIES = size("DELIVERIES", 100_000);
const migrationName = "0456_chat_review_lookup_indexes";
const migration = readFileSync(new URL(`../packages/db/src/migrations/${migrationName}.sql`, import.meta.url), "utf8");
const indexNames = [...migration.matchAll(/IF NOT EXISTS "([a-z_]+)"/g)].map(match => match[1]!);

const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  temporary = await startEmbeddedPostgresTestDatabase("review-lookup-index-migration-");
  db = createDb(temporary.connectionString);
  const sql = db.$client;
  for (const name of indexNames) await sql.unsafe(`DROP INDEX IF EXISTS "${name}"`);
  const { companyId, agentId, issueId, endpointId, conversationId } = await seedGitHubReviewWait(db);
  await sql.unsafe("create extension if not exists pgcrypto");

  const loadStart = performance.now();
  // Incompressible run contexts; half were woken by a comment.
  await sql.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot)
    select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object(
      'wakeCommentId', case when g % 2 = 0 then gen_random_uuid()::text end, 'issueId', $3::text,
      'prompt', (select string_agg(encode(gen_random_bytes(768), 'base64'), '') from generate_series(1, $4::int) s(i) where g > 0))
    from generate_series(1, $5::int) g`, [companyId, agentId, issueId, RUN_CONTEXT_KIB, RUNS]);
  await sql.unsafe(`insert into issue_comments (company_id, issue_id, author_user_id, body)
    select $1::uuid, $2::uuid, 'operator', 'load ' || g from generate_series(1, $3::int) g`, [companyId, issueId, LINKS]);
  await sql.unsafe(`insert into chat_deliveries (company_id, endpoint_id, conversation_id, provider_event_id,
      deduplication_key, event_kind, state, normalized_event)
    select $1::uuid, $2::uuid, $3::uuid, 'load-' || g, 'load-' || g, 'message', 'processed',
      jsonb_build_object('githubAutomatic', jsonb_build_object('context', jsonb_build_object(
        'deliveryId', gen_random_uuid()::text, 'body', (select string_agg(encode(gen_random_bytes(768), 'base64'), '') from generate_series(1, 2) s(i) where g > 0))))
    from generate_series(1, $4::int) g`, [companyId, endpointId, conversationId, DELIVERIES]);
  await sql.unsafe(`with c as (select id, row_number() over (order by id) rn from issue_comments where company_id = $1::uuid),
      d as (select id, row_number() over (order by id) rn from chat_deliveries where endpoint_id = $2::uuid)
    insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
      provider_message_id, direction)
    select $1::uuid, $2::uuid, $3::uuid, d.id, c.id, 'load-' || c.rn,
      case when c.rn % 2 = 0 then 'inbound' else 'outbound' end
    from c left join d on d.rn = c.rn`, [companyId, endpointId, conversationId]);
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const tableSizes = await sql.unsafe(`select relname as table, n_live_tup::bigint::text as rows,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_stat_user_tables
    where relname in ('chat_message_links', 'chat_deliveries', 'heartbeat_runs') order by relname`);

  async function migrate() {
    await sql.unsafe(`delete from drizzle.__drizzle_migrations where hash in (
      select hash from drizzle.__drizzle_migrations order by created_at desc limit 1)`);
    const start = performance.now();
    await applyPendingMigrations(temporary!.connectionString);
    return performance.now() - start;
  }
  // First run builds every index; the rerun finds them valid and skips them.
  const firstRunMs = await migrate();
  const valid = await sql.unsafe(`select c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) as size
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname in (${indexNames.map((_, n) => `$${n + 1}`).join(", ")})
    order by c.relname`, indexNames);
  assert.equal(valid.length, indexNames.length);
  assert.ok(valid.every(row => row.indisvalid));
  const rerunMs = await migrate();
  // Per-index build time, measured separately with the same statements.
  const builds: Array<{ index: string; ms: number }> = [];
  for (const statement of migration.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean)) {
    const name = statement.match(/IF NOT EXISTS "([a-z_]+)"/)![1]!;
    await sql.unsafe(`DROP INDEX CONCURRENTLY "${name}"`);
    const start = performance.now();
    await sql.unsafe(statement);
    builds.push({ index: name, ms: Math.round(performance.now() - start) });
  }
  console.log(JSON.stringify({
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version,
    fixture: { synthetic: true, runs: RUNS, runContextKiB: RUN_CONTEXT_KIB, links: LINKS, deliveries: DELIVERIES,
      loadMs: Math.round(loadMs), tableSizes },
    migration: { firstRunMs: Math.round(firstRunMs), rerunMs: Math.round(rerunMs), indexes: valid, builds },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  } finally { clearInterval(keepAlive); }
}
