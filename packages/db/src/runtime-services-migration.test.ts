import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "0280_special_whiplash.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
// An explicitly supplied disposable server avoids platform-specific embedded limits.
const externalDatabaseUrl = process.env.PAPERCLIP_RUNTIME_SERVICE_MIGRATION_TEST_DATABASE_URL;
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function seed(sql: postgres.Sql) {
  const company = randomUUID(), allocation = randomUUID(), service = randomUUID(), task = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Migration fixture', 'MIG')`;
  await sql`INSERT INTO issues (id, company_id, title) VALUES (${task}, ${company}, 'Retained task')`;
  await sql`INSERT INTO runtime_service_allocations (id, company_id, provider, reuse_key, cwd, metadata, storage_usage)
    VALUES (${allocation}, ${company}, 'local', 'retained', '/fixture/workspace', '{"credentialBinding":"fixture-reference"}', '{"sourceBytes":42}')`;
  await sql`INSERT INTO runtime_services (id, company_id, allocation_id, name, purpose, issue_id, creation_key, spec, policy, process_ref)
    VALUES (${service}, ${company}, ${allocation}, 'App', 'Retained app', ${task}, 'create-once', '{"command":"node"}', '{}', '{"identity":"fixture-process"}')`;
  await sql`INSERT INTO runtime_service_shares (company_id, service_id, endpoint_name, token_hash, creation_key, expires_at)
    VALUES (${company}, ${service}, 'web', 'fixture-share-hash', 'share-once', now() + interval '1 day')`;
  await sql`INSERT INTO runtime_service_task_workspaces (company_id, allocation_id, issue_id, host_cwd, created_by_user_id)
    VALUES (${company}, ${allocation}, ${task}, '/fixture/workspace', 'fixture-user')`;
  await sql`INSERT INTO runtime_service_data_deletions (company_id, allocation_id, service_id, target, "authorization")
    VALUES (${company}, ${allocation}, ${service}, '{"receipt":"fixture-deletion"}', '{"kind":"operator"}')`;
  return { company, allocation, service, task };
}

async function retainedState(sql: postgres.Sql) {
  const tables = ["runtime_service_allocations", "runtime_services", "runtime_service_shares", "runtime_service_task_workspaces", "runtime_service_data_deletions"];
  return Promise.all(tables.map(table => sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`)));
}

async function verifyReplay(sql: postgres.Sql, url: string) {
  const identity = await seed(sql);
  const before = await retainedState(sql);
  await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
  await applyPendingMigrations(url);
  await sql.begin(async tx => { for (const statement of migrationSql.split("--> statement-breakpoint")) if (statement.trim()) await tx.unsafe(statement); });
  expect(await inspectMigrations(url)).toMatchObject({ status: "upToDate" });
  expect(await retainedState(sql)).toEqual(before);
  await expect(sql`INSERT INTO runtime_service_allocations (company_id, provider, reuse_key, cwd) VALUES (${identity.company}, 'local', 'retained', '/other')`).rejects.toMatchObject({ code: "23505" });
  await sql`DELETE FROM issues WHERE id = ${identity.task}`;
  expect(await sql`SELECT issue_id FROM runtime_service_task_workspaces WHERE allocation_id = ${identity.allocation}`).toEqual([{ issue_id: null }]);
  expect(await sql`SELECT id FROM runtime_services WHERE id = ${identity.service}`).toHaveLength(1);
}

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type HistoricalMigration = { entry: JournalEntry; sql: string };
const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: JournalEntry[] };
const published = JSON.parse(await readFile(new URL("./__fixtures__/runtime-services-published-migration.json", import.meta.url), "utf8")) as { entry: JournalEntry; sha256: string };

async function emptyDatabase() {
  let adminUrl = externalDatabaseUrl;
  if (!adminUrl) {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-services-migration-");
    cleanups.push(database.cleanup);
    adminUrl = database.connectionString;
  }
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  cleanups.push(async () => admin.end());
  const name = "runtime_migration_" + randomUUID().replaceAll("-", "");
  await admin.unsafe('CREATE DATABASE "' + name + '"');
  cleanups.push(async () => { await admin.unsafe('DROP DATABASE "' + name + '"'); });
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { sql, url: url.toString() };
}

async function applyHistory(sql: postgres.Sql, throughIndex: number, additions: HistoricalMigration[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "paperclip-services-history-"));
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "meta"));
  const entries = journal.entries.filter(entry => entry.idx <= throughIndex);
  for (const entry of entries) {
    await writeFile(join(directory, entry.tag + ".sql"), await readFile(new URL("./migrations/" + entry.tag + ".sql", import.meta.url), "utf8"));
  }
  for (const item of additions) {
    entries.push(item.entry);
    await writeFile(join(directory, item.entry.tag + ".sql"), item.sql);
  }
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  await migrate(drizzle(sql), { migrationsFolder: directory });
}

async function history(sql: postgres.Sql) {
  return sql.unsafe<{ id: number; hash: string; created_at: string }[]>("SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id");
}

async function expectHistoryPreserved(sql: postgres.Sql, before: Awaited<ReturnType<typeof history>>) {
  const after = await history(sql);
  expect(after.filter(row => before.some(original => original.id === row.id))).toEqual(before);
}

async function expectAnnouncements(sql: postgres.Sql) {
  expect(await sql.unsafe("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('announcement_dismissals', 'announcement_publications') ORDER BY table_name"))
    .toEqual([{ table_name: "announcement_dismissals" }, { table_name: "announcement_publications" }]);
}

describePostgres("runtime service migration", () => {
  it("upgrades current master and replays without changing retained or announcement state", async () => {
    const { sql, url } = await emptyDatabase();
    await applyHistory(sql, 279);
    await sql.unsafe("INSERT INTO announcement_publications (announcement_id) VALUES ('fixture-announcement')");
    await sql.unsafe("INSERT INTO announcement_dismissals (user_id, announcement_id) VALUES ('fixture-user', 'fixture-announcement')");
    const announcements = await sql.unsafe("SELECT * FROM announcement_dismissals");
    const before = await history(sql);
    expect(await inspectMigrations(url)).toMatchObject({ pendingMigrations: [migrationFile] });
    await applyPendingMigrations(url);
    await verifyReplay(sql, url);
    await expectHistoryPreserved(sql, before);
    expect(await sql.unsafe("SELECT * FROM announcement_dismissals")).toEqual(announcements);
    expect(await sql.unsafe("SELECT * FROM announcement_publications")).toEqual([{ announcement_id: "fixture-announcement" }]);
    await expect(sql.unsafe("INSERT INTO announcement_dismissals (user_id, announcement_id) VALUES ('fixture-user', 'fixture-announcement')")).rejects.toMatchObject({ code: "23505" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("upgrades original development history without skipping intervening master migrations", async () => {
    const { sql, url } = await emptyDatabase();
    const legacy = JSON.parse(await readFile(new URL("./__fixtures__/runtime-services-development-migrations.json", import.meta.url), "utf8")) as HistoricalMigration[];
    await applyHistory(sql, 272, legacy);
    const before = await history(sql);
    expect(await inspectMigrations(url)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: expect.arrayContaining(["0274_agent_chat.sql", "0278_nappy_colonel_america.sql", "0279_tired_deathstrike.sql", migrationFile]),
    });
    await verifyReplay(sql, url);
    await expectHistoryPreserved(sql, before);
    await expectAnnouncements(sql);
    expect(await sql.unsafe("SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'conversation_state'")).toHaveLength(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("recognizes published review0278 by hash and applies older master additions without rewriting provenance", async () => {
    const { sql, url } = await emptyDatabase();
    // Renumbering must preserve the exact published SQL, not fabricate a new
    // historical migration or replay one whose journal timestamp is newer.
    expect(migrationHash).toBe(published.sha256);
    await applyHistory(sql, 277, [{ entry: published.entry, sql: migrationSql }]);
    await seed(sql);
    const retained = await retainedState(sql);
    const before = await history(sql);
    expect(before.at(-1)).toMatchObject({ hash: published.sha256, created_at: String(published.entry.when) });
    expect(await inspectMigrations(url)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: ["0278_nappy_colonel_america.sql", "0279_tired_deathstrike.sql"],
    });
    await applyPendingMigrations(url);
    await expectHistoryPreserved(sql, before);
    expect(await retainedState(sql)).toEqual(retained);
    await expectAnnouncements(sql);
    expect((await history(sql)).filter(row => row.hash === published.sha256)).toHaveLength(1);
    expect(await inspectMigrations(url)).toMatchObject({ status: "upToDate" });
    const completeHistory = await history(sql);
    await applyPendingMigrations(url);
    expect(await history(sql)).toEqual(completeHistory);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
