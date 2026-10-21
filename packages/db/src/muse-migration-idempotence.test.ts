import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const museMigrations = [
  { file: "0349_oval_dragon_lord.sql", preview: "0344_perpetual_eternity.sql", hash: "5c422698d40da1d6cdc587134553e371f7c807ce9617e07d7ff77eb05810ae49" },
  { file: "0350_friendly_rhodey.sql", preview: "0345_lumpy_celestials.sql", hash: "a9373b52e02fa985bf10c15da91f6681c49d8726d94d5d68fd77e5802fd47a68" },
  { file: "0351_hard_albert_cleary.sql", preview: "0346_powerful_epoch.sql", hash: "65f4f08c6a8fed7396db491e0691e693636f48c4ca4fa63cd2057af38039861a" },
  { file: "0352_special_warbound.sql", preview: "0347_big_meggan.sql", hash: "1d2d5834fd499b60a43778d6d14b2520e3e2980258b8c0997d80cb95465f4abf" },
  { file: "0353_skinny_gamma_corps.sql", preview: "0348_foamy_lightspeed.sql", hash: "1a379bc03d80c34815546bb9f50bf1408ccf156f4a1df2d86edb0a01acdc55c0" },
] as const;
const museTables = [
  "external_agent_holds", "muse_agent_bindings", "muse_credentials", "muse_idle_receipts",
  "muse_input_deliveries", "muse_mailbox_items", "muse_receiver_contact_buckets",
  "muse_runner_assignments", "muse_runner_operations",
] as const;
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function database() {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-muse-migration-replay-");
  cleanups.push(db.cleanup);
  const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => { await sql.end(); });
  return { sql, url: db.connectionString };
}
async function content(file: string) {
  return readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
}
function statements(sql: string) { return sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean); }
async function rawReplay(sql: ReturnType<typeof postgres>) {
  for (const migration of museMigrations) for (const statement of statements(await content(migration.file))) await sql.unsafe(statement);
}
async function history(sql: ReturnType<typeof postgres>) {
  return Array.from(await sql`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
}
async function shape(sql: ReturnType<typeof postgres>) {
  return {
    columns: Array.from(await sql`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    constraints: Array.from(await sql`SELECT t.relname, c.conname, c.convalidated, pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' ORDER BY t.relname, c.conname`),
    indexes: Array.from(await sql`SELECT t.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' ORDER BY t.relname, definition`),
  };
}
async function removeMuseSchemaAndReceipts(sql: ReturnType<typeof postgres>) {
  // A disposable, fully migrated DB supplies the canonical prefix. Remove only
  // this feature's tables/receipts to model interrupted unjournaled DDL.
  await sql.unsafe(`DROP TABLE ${museTables.map(table => `"${table}"`).join(", ")} CASCADE`);
  for (const migration of museMigrations) {
    const hash = createHash("sha256").update(await content(migration.file)).digest("hex");
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
  }
}
async function seedRows(sql: ReturnType<typeof postgres>, complete: boolean) {
  const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Migration replay', 'RPL') RETURNING id`;
  const [agent] = await sql`INSERT INTO agents (company_id, name, adapter_type) VALUES (${company.id}, 'Retained agent', 'paperclip_runner') RETURNING id`;
  const [task] = await sql`INSERT INTO issues (company_id, title, assignee_agent_id) VALUES (${company.id}, 'Retained task', ${agent.id}) RETURNING id`;
  const [run] = await sql`INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status)
    VALUES (${company.id}, ${agent.id}, 'assignment', 'system', 'failed') RETURNING id`;
  const [binding] = await sql`INSERT INTO muse_agent_bindings (company_id, agent_id, operator_id, generation, revision, status, worker_cursor, detector_removed_at, revoked_at)
    VALUES (${company.id}, ${agent.id}, 'synthetic-operator', 3, 9, 'revoked', 13, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z') RETURNING id`;
  const [assignment] = await sql`INSERT INTO muse_runner_assignments (company_id, binding_id, binding_generation, run_id, agent_id,
    normalized_session_id, turn_id, controller_generation, catalog_digest, status, projection, accept_by, expires_at)
    VALUES (${company.id}, ${binding.id}, 3, ${run.id}, ${agent.id}, 'retained-session', 'retained-turn', 4, 'retained-digest', 'fenced',
      '{"retained":true}'::jsonb, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z') RETURNING id`;
  await sql`INSERT INTO external_agent_holds (company_id, agent_id, provider, assignment_id, binding_id, binding_generation, run_id, worker_unknown, native_effects_unknown, stop_boundary)
    VALUES (${company.id}, ${agent.id}, 'muse', ${assignment.id}, ${binding.id}, 3, ${run.id}, true, true, '{"retained":true}'::jsonb)`;
  await sql`INSERT INTO muse_credentials (company_id, binding_id, binding_generation, kind, family_id, token_hash, expires_at, revoked_at)
    VALUES (${company.id}, ${binding.id}, 3, 'cleanup', ${randomUUID()}, ${randomUUID()}, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')`;
  await sql`INSERT INTO muse_idle_receipts (company_id, binding_id, binding_generation, request_id, digest, outcome)
    VALUES (${company.id}, ${binding.id}, 3, ${randomUUID()}, 'retained-idle', '{"retained":true}'::jsonb)`;
  await sql`INSERT INTO muse_input_deliveries (company_id, assignment_id, request_id, turn_id, input_digest, response, source_event_id, consumed_at, continuation_receipt_id)
    VALUES (${company.id}, ${assignment.id}, 'retained-input', 'retained-turn', 'retained-digest', '{"retained":true}'::jsonb, 'retained-input-event', '2026-01-01T00:00:00Z', ${randomUUID()})`;
  await sql`INSERT INTO muse_mailbox_items (company_id, binding_id, binding_generation, assignment_id, kind, source_event_id, "references")
    VALUES (${company.id}, ${binding.id}, 3, ${assignment.id}, 'assignment', 'retained-mailbox', '{"retained":true}'::jsonb)`;
  await sql`INSERT INTO muse_receiver_contact_buckets (company_id, binding_id, binding_generation, replica_id, bucket_at, first_at, last_at, contacts, gaps_at_most_seven_seconds, max_gap_ms)
    VALUES (${company.id}, ${binding.id}, 3, ${randomUUID()}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:03Z', 2, 1, 2000)`;
  await sql`INSERT INTO muse_runner_operations (company_id, assignment_id, request_id, digest, command, status, outcome)
    VALUES (${company.id}, ${assignment.id}, ${randomUUID()}, 'retained-operation', '{"retained":true}'::jsonb, 'unknown', '{"retained":true}'::jsonb)`;
  const userId = randomUUID(), clientId = `replay-client-${randomUUID()}`;
  await sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${userId}, 'Synthetic operator', ${`${userId}@example.test`}, now(), now())`;
  await sql`INSERT INTO mcp_oauth_clients (id, name, redirect_uris) VALUES (${clientId}, 'Synthetic client', '["https://example.test/callback"]'::jsonb)`;
  const [grant] = await sql`INSERT INTO mcp_oauth_grants (company_id, user_id, client_id, resource, purpose, agent_id, scopes)
    VALUES (${company.id}, ${userId}, ${clientId}, 'https://example.test/api/muse/v1', 'agent', ${agent.id}, '["paperclip:agent","offline_access"]'::jsonb) RETURNING id`;
  await sql`UPDATE muse_agent_bindings SET grant_id = ${grant.id} WHERE id = ${binding.id}`;
  if (complete) {
    await sql`UPDATE muse_agent_bindings SET qualification_started_at = '2026-01-01T00:00:00Z', deadline_enforced_at = '2026-01-02T00:00:00Z',
      cadence_evidence_incomplete_at = '2026-01-03T00:00:00Z', detector_removal_requested_at = '2026-01-04T00:00:00Z' WHERE id = ${binding.id}`;
    await sql`UPDATE muse_receiver_contact_buckets SET timestamps = '["2026-01-01T00:00:01Z"]'::jsonb, incomplete = true WHERE binding_id = ${binding.id}`;
    await sql`UPDATE muse_mailbox_items SET signal_attempt = 9, signal_notified_at = '2026-01-05T00:00:00Z' WHERE binding_id = ${binding.id}`;
    await sql`UPDATE muse_runner_operations SET continuation_receipt_id = ${randomUUID()} WHERE assignment_id = ${assignment.id}`;
  }
  return async () => {
    const rows: Record<string, unknown[]> = {};
    for (const table of [...museTables, "companies", "issues", "heartbeat_runs", "mcp_oauth_grants"] as const) {
      rows[table] = Array.from(await sql.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${table === "companies" ? "id" : "company_id"} = $1 ORDER BY id`, [company.id])).map(row => row.row);
    }
    return rows;
  };
}

describePostgres("Muse migration SQL idempotence", () => {
  it("replays every raw SQL file twice without changing schema, receipts or runtime evidence", async () => {
    const { sql, url } = await database();
    const rows = await seedRows(sql, true);
    const before = { shape: await shape(sql), history: await history(sql), rows: await rows() };
    await rawReplay(sql);
    await rawReplay(sql);
    expect(await shape(sql)).toEqual(before.shape);
    expect(await history(sql)).toEqual(before.history);
    expect(await rows()).toEqual(before.rows);
    await applyPendingMigrations(url);
    expect((await inspectMigrations(url)).status).toBe("upToDate");
    expect(await history(sql)).toEqual(before.history);
    expect(await rows()).toEqual(before.rows);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("completes mixed partial unjournaled DDL and preserves existing rows and journal identities", async () => {
    const { sql, url } = await database();
    const expectedShape = await shape(sql);
    await removeMuseSchemaAndReceipts(sql);
    const prefixHistory = await history(sql);
    const baseStatements = statements(await content(museMigrations[0].file));
    for (const statement of baseStatements.slice(0, 10)) await sql.unsafe(statement);
    await sql.unsafe(baseStatements.find(statement => /^CREATE (?:UNIQUE )?INDEX/.test(statement))!);
    for (const migration of museMigrations.slice(1)) await sql.unsafe(statements(await content(migration.file))[0]);
    // A same-named FK elsewhere must not hide the missing public-table FK.
    await sql`CREATE SCHEMA migration_decoy`;
    await sql`CREATE TABLE migration_decoy.constraint_owner (binding_id uuid,
      CONSTRAINT muse_credentials_binding_id_muse_agent_bindings_id_fk FOREIGN KEY (binding_id) REFERENCES public.companies(id))`;
    const rows = await seedRows(sql, false);
    const beforeRows = await rows();
    await applyPendingMigrations(url);
    expect((await inspectMigrations(url)).status).toBe("upToDate");
    expect(await shape(sql)).toEqual(expectedShape);
    expect(await rows()).toMatchObject(beforeRows);
    const afterHistory = await history(sql);
    expect(afterHistory.slice(0, prefixHistory.length)).toEqual(prefixHistory);
    expect(afterHistory).toHaveLength(prefixHistory.length + museMigrations.length);
    expect(await sql`SELECT timestamps, incomplete FROM muse_receiver_contact_buckets`).toMatchObject([{ timestamps: [], incomplete: false }]);
    expect(await sql`SELECT signal_attempt, signal_notified_at FROM muse_mailbox_items`).toMatchObject([{ signal_attempt: 0, signal_notified_at: null }]);
    const finalRows = await rows();
    await rawReplay(sql);
    await applyPendingMigrations(url);
    expect(await history(sql)).toEqual(afterHistory);
    expect(await shape(sql)).toEqual(expectedShape);
    expect(await rows()).toEqual(finalRows);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("retains exact preview SQL hashes and receipts while journaling guarded successors", async () => {
    const { sql, url } = await database();
    const expectedShape = await shape(sql);
    await removeMuseSchemaAndReceipts(sql);
    for (const [index, migration] of museMigrations.entries()) {
      const preview = await readFile(new URL(`./__fixtures__/muse-preview-migrations/${migration.preview}`, import.meta.url), "utf8");
      expect(createHash("sha256").update(preview).digest("hex")).toBe(migration.hash);
      expect(createHash("sha256").update(await content(migration.file)).digest("hex")).not.toBe(migration.hash);
      for (const statement of statements(preview)) await sql.unsafe(statement);
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${migration.hash}, ${1791904391794 + index})`;
    }
    const rows = await seedRows(sql, true), beforeRows = await rows(), beforeHistory = await history(sql);
    await applyPendingMigrations(url);
    expect((await inspectMigrations(url)).status).toBe("upToDate");
    expect(await shape(sql)).toEqual(expectedShape);
    expect(await rows()).toEqual(beforeRows);
    const afterHistory = await history(sql);
    expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
    expect(afterHistory).toHaveLength(beforeHistory.length + museMigrations.length);
    for (const migration of museMigrations) expect(afterHistory.filter(row => row.hash === migration.hash)).toHaveLength(1);
    await applyPendingMigrations(url);
    expect(await history(sql)).toEqual(afterHistory);
    expect(await rows()).toEqual(beforeRows);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
