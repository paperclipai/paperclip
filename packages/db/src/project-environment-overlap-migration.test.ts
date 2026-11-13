import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const migrations = ["0466_drop_project_environment.sql", "0467_fair_human_torch.sql"];
const hashes = await Promise.all(migrations.map(async (file) => createHash("sha256")
  .update(await readFile(new URL(`./migrations/${file}`, import.meta.url))).digest("hex")));

describePostgres("project environment rolling migration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-environment-overlap-");
    sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  async function prepare() {
    await sql`DELETE FROM projects`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(hashes)}`;
    const environmentIds = [randomUUID(), randomUUID()];
    await sql`INSERT INTO environments (id, name, driver) VALUES
      (${environmentIds[0]}, ${randomUUID()}, 'ssh'), (${environmentIds[1]}, ${randomUUID()}, 'ssh')`;
    const projectIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let index = 0; index < projectIds.length; index++) {
      const companyId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Legacy company', ${`P${index}${companyId.slice(0, 6)}`})`;
      await sql`INSERT INTO projects (id, company_id, name, environment_id) VALUES
        (${projectIds[index]}, ${companyId}, 'Legacy project', ${environmentIds[index] ?? null})`;
    }
    return { environmentIds, projectIds };
  }

  const rows = () => sql`SELECT id, environment_id FROM projects ORDER BY id`;
  const receipts = () => sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(hashes)} ORDER BY hash`;

  it("preserves committed old-writer values and gives concurrent old readers an unbroken column", async () => {
    const { environmentIds, projectIds } = await prepare();
    const writer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const readerUrl = new URL(database.connectionString);
    readerUrl.searchParams.set("application_name", "project-column-overlap-reader");
    const reader = postgres(readerUrl.toString(), { max: 1, onnotice: () => {} });
    const migrationUrl = new URL(database.connectionString);
    migrationUrl.searchParams.set("application_name", "project-column-overlap-migrator");
    let migration: Promise<void> | undefined;
    let read: Promise<unknown> | undefined;
    try {
      await writer`BEGIN`;
      await writer`UPDATE projects SET environment_id = ${environmentIds[1]} WHERE id = ${projectIds[0]}`;
      migration = applyPendingMigrations(migrationUrl.toString());
      await expect.poll(async () => (await sql`SELECT EXISTS (
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = 'projects'::regclass AND l.mode = 'AccessExclusiveLock' AND NOT l.granted
          AND a.application_name = 'project-column-overlap-migrator') AS waiting`)[0]?.waiting,
      { timeout: 10_000 }).toBe(true);
      read = reader`SELECT id, environment_id FROM projects ORDER BY id`.then((result) => Array.from(result));
      await expect.poll(async () => (await sql`SELECT EXISTS (
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = 'projects'::regclass AND l.mode = 'AccessShareLock' AND NOT l.granted
          AND a.application_name = 'project-column-overlap-reader') AS waiting`)[0]?.waiting,
      { timeout: 10_000 }).toBe(true);
      const before = Array.from(await writer`SELECT id, environment_id FROM projects ORDER BY id`);
      await writer`COMMIT`;
      await migration;
      expect(await read).toEqual(before);
      expect(Array.from(await rows())).toEqual(before);
      expect(Array.from(await receipts())).toEqual(hashes.toSorted().map((hash) => ({ hash })));
      const state = await inspectMigrations(database.connectionString);
      expect(state.status).toBe("upToDate");
      await applyPendingMigrations(database.connectionString);
      expect(Array.from(await rows())).toEqual(before);
      expect(await receipts()).toHaveLength(2);
      await writer`UPDATE projects SET environment_id = ${environmentIds[0]} WHERE id = ${projectIds[0]}`;
      await sql`DELETE FROM environments WHERE id = ${environmentIds[0]}`;
      expect((await sql`SELECT environment_id FROM projects WHERE id = ${projectIds[0]}`)[0]?.environment_id).toBeNull();
    } finally {
      await writer`ROLLBACK`;
      await Promise.allSettled([migration, read]);
      await Promise.all([writer.end(), reader.end()]);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rolls back both DDL and genuine receipts if restoring the legacy values fails", async () => {
    await prepare();
    const before = Array.from(await rows());
    await sql.unsafe(`CREATE FUNCTION reject_project_environment_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'project_environment_restore_fixture'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_project_environment_restore BEFORE UPDATE ON projects
      FOR EACH ROW EXECUTE FUNCTION reject_project_environment_restore()`);
    try {
      await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow("project_environment_restore_fixture");
      expect(Array.from(await rows())).toEqual(before);
      expect(await receipts()).toHaveLength(0);
    } finally {
      await sql.unsafe("DROP TRIGGER reject_project_environment_restore ON projects");
      await sql.unsafe("DROP FUNCTION reject_project_environment_restore()");
    }
    await applyPendingMigrations(database.connectionString);
    expect(Array.from(await rows())).toEqual(before);
    expect(await receipts()).toHaveLength(2);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("applies only the additive repair when the published drop was already committed", async () => {
    await sql`DELETE FROM projects`;
    await sql.unsafe('ALTER TABLE projects DROP COLUMN environment_id');
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hashes[1]}`;
    await applyPendingMigrations(database.connectionString);
    expect((await sql`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'environment_id'`)[0])
      .toEqual({ data_type: "uuid", is_nullable: "YES" });
    expect((await sql`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'projects'::regclass
      AND conname = 'projects_environment_id_environments_id_fk'`)[0]?.confdeltype).toBe("n");
    expect(await receipts()).toHaveLength(2);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
