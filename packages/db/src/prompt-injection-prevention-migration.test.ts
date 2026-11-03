import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migration = await readFile(new URL("./migrations/0362_large_roughhouse.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migration).digest("hex");
// SQL published by this PR before its replay guards were added (14a1d73991).
const originalMigrationHash = "bf087cbc9551b3c07aabffac45c87239ba53d1a095f03807d4ff98718028ea25";
const statements = migration.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function database() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-injection-migration-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => { await sql.end(); });
  return { sql, url: database.connectionString };
}
async function replay(sql: ReturnType<typeof postgres>) {
  for (const statement of statements) await sql.unsafe(statement);
}
async function history(sql: ReturnType<typeof postgres>) {
  return Array.from(await sql`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
}
async function shape(sql: ReturnType<typeof postgres>) {
  return {
    columns: Array.from(await sql`SELECT table_name, column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name IN ('company_prompt_injection_prevention', 'prompt_injection_invocations', 'budget_reservations', 'cost_events')
      ORDER BY table_name, column_name`),
    constraints: Array.from(await sql`SELECT t.relname, c.conname, c.convalidated, pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
      AND t.relname IN ('company_prompt_injection_prevention', 'prompt_injection_invocations', 'budget_reservations', 'cost_events')
      ORDER BY t.relname, c.conname`),
    indexes: Array.from(await sql`SELECT t.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
      AND t.relname IN ('company_prompt_injection_prevention', 'prompt_injection_invocations', 'budget_reservations', 'cost_events')
      ORDER BY t.relname, definition`),
  };
}
async function seed(sql: ReturnType<typeof postgres>) {
  const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Migration replay', 'PIM') RETURNING id`;
  const connectionId = randomUUID(), grantId = randomUUID();
  await sql`INSERT INTO company_prompt_injection_prevention (company_id, connection_id, grant_id, enabled, model)
    VALUES (${company.id}, ${connectionId}, ${grantId}, true, 'openai/gpt-oss-safeguard-20b')`;
  const [charge] = await sql`INSERT INTO cost_events
    (company_id, usage_kind, provider, biller, billing_type, cost_status, model, cost_cents, occurred_at)
    VALUES (${company.id}, 'prompt_injection', 'openai', 'openrouter', 'metered_api', 'unpriced', 'openai/gpt-oss-safeguard-20b', 0, now()) RETURNING id`;
  const [invocation] = await sql`INSERT INTO prompt_injection_invocations
    (company_id, source, actor_type, actor_id, connection_id, grant_id, policy_version, model, status, error_code, cost_event_id)
    VALUES (${company.id}, 'gateway', 'system', 'retained-actor', ${connectionId}, ${grantId}, 'tool-result-v1',
      'openai/gpt-oss-safeguard-20b', 'unknown', 'timeout', ${charge.id}) RETURNING id`;
  await sql`INSERT INTO budget_reservations (company_id, prompt_injection_invocation_id, amount_cents, state)
    VALUES (${company.id}, ${invocation.id}, 10, 'held')`;
  return { companyId: company.id, invocationId: invocation.id, chargeId: charge.id };
}
async function rows(sql: ReturnType<typeof postgres>) {
  return {
    settings: Array.from(await sql`SELECT to_jsonb(t) AS row FROM company_prompt_injection_prevention t ORDER BY company_id`),
    invocations: Array.from(await sql`SELECT to_jsonb(t) AS row FROM prompt_injection_invocations t ORDER BY id`),
    charges: Array.from(await sql`SELECT to_jsonb(t) AS row FROM cost_events t ORDER BY id`),
    reservations: Array.from(await sql`SELECT to_jsonb(t) AS row FROM budget_reservations t ORDER BY id`),
  };
}

describe("prompt injection migration replay", () => {
  it("replays raw SQL twice without changing settings, accounting, schema, or migration receipts", async () => {
    const { sql } = await database();
    const fixture = await seed(sql);
    const before = { shape: await shape(sql), rows: await rows(sql), history: await history(sql) };
    await replay(sql);
    await replay(sql);
    expect(await shape(sql)).toEqual(before.shape);
    expect(await rows(sql)).toEqual(before.rows);
    expect(await history(sql)).toEqual(before.history);
    await expect(sql`UPDATE company_prompt_injection_prevention SET grant_id = NULL WHERE company_id = ${fixture.companyId}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`UPDATE prompt_injection_invocations SET status = 'invalid' WHERE id = ${fixture.invocationId}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`UPDATE cost_events SET usage_kind = 'invalid' WHERE id = ${fixture.chargeId}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`UPDATE budget_reservations SET prompt_injection_invocation_id = NULL WHERE company_id = ${fixture.companyId}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`INSERT INTO budget_reservations (company_id, prompt_injection_invocation_id, amount_cents)
      VALUES (${fixture.companyId}, ${fixture.invocationId}, 10)`).rejects.toMatchObject({ code: "23505" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("finishes partial unjournaled DDL without losing existing configuration or unresolved charges", async () => {
    const { sql, url } = await database();
    const expectedShape = await shape(sql);
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    await sql`DROP TABLE prompt_injection_invocations`;
    await sql`DROP TABLE company_prompt_injection_prevention`;
    await sql`ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_source_check`;
    await sql`ALTER TABLE budget_reservations DROP COLUMN prompt_injection_invocation_id`;
    await sql`ALTER TABLE cost_events DROP CONSTRAINT cost_events_usage_kind_check`;
    // Keep mixed completed work, including a table, column, index and FK. The
    // missing journal receipt must not cause any of those objects to collide.
    for (const statement of statements.slice(0, 2)) await sql.unsafe(statement);
    await sql.unsafe(statements.find(statement => statement.includes('ADD COLUMN') && statement.includes('prompt_injection_invocation_id'))!);
    await sql.unsafe(statements.find(statement => statement.includes('CREATE INDEX') && statement.includes('prompt_injection_invocations_company_started_idx'))!);
    await sql.unsafe(statements.find(statement => statement.includes('ADD CONSTRAINT "company_prompt_injection_prevention_company_id_companies_id_fk"'))!);
    await seed(sql);
    const beforeRows = await rows(sql), beforeHistory = await history(sql);
    await applyPendingMigrations(url);
    expect((await inspectMigrations(url)).status).toBe("upToDate");
    expect(await shape(sql)).toEqual(expectedShape);
    expect(await rows(sql)).toEqual(beforeRows);
    const afterHistory = await history(sql);
    expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
    expect(afterHistory).toHaveLength(beforeHistory.length + 1);
    await replay(sql);
    await applyPendingMigrations(url);
    expect(await history(sql)).toEqual(afterHistory);
    expect(await rows(sql)).toEqual(beforeRows);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves the original SQL receipt when upgrading a company that already applied this PR", async () => {
    const { sql, url } = await database();
    await seed(sql);
    await sql`UPDATE drizzle.__drizzle_migrations SET hash = ${originalMigrationHash} WHERE hash = ${migrationHash}`;
    const before = { shape: await shape(sql), rows: await rows(sql), history: await history(sql) };
    await applyPendingMigrations(url);
    expect((await inspectMigrations(url)).status).toBe("upToDate");
    expect(await shape(sql)).toEqual(before.shape);
    expect(await rows(sql)).toEqual(before.rows);
    const after = await history(sql);
    expect(after.slice(0, before.history.length)).toEqual(before.history);
    expect(after.some(row => row.hash === originalMigrationHash)).toBe(true);
    expect(after.filter(row => row.hash === migrationHash)).toHaveLength(1);
    await applyPendingMigrations(url);
    expect(await history(sql)).toEqual(after);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
