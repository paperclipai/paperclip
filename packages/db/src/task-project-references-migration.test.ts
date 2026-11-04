import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationName = "0432_task_project_references.sql";
const migrationHash = createHash("sha256").update(await readFile(new URL(`./migrations/${migrationName}`, import.meta.url), "utf8")).digest("hex");
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("task project references migration", () => {
  it("backfills candidates for existing tasks and fences later writes", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-task-project-references-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`DROP TABLE issue_project_references`;
      await sql`DROP FUNCTION paperclip_issue_project_references, paperclip_bump_issue_context_reference_revision,
        paperclip_document_body_project_references, paperclip_issue_document_project_references, paperclip_row_project_references,
        paperclip_sync_project_reference_sources, paperclip_project_reference_candidates CASCADE`;
      await sql`ALTER TABLE issues DROP COLUMN context_reference_revision`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      const companyId = randomUUID(), [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
      const [primaryOnly, mentioned, untouched] = [randomUUID(), randomUUID(), randomUUID()];
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Upgrade', 'UPR')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${a}, ${companyId}, 'A'), (${b}, ${companyId}, 'B')`;
      await sql`INSERT INTO issues (id, company_id, title, project_id, description) VALUES
        (${primaryOnly}, ${companyId}, 'Primary', ${a}, null),
        (${mentioned}, ${companyId}, 'Mentions', null, ${`[b](project://${b})`}),
        (${untouched}, ${companyId}, 'Plain', null, 'no links')`;
      await sql`INSERT INTO issue_comments (company_id, issue_id, body) VALUES (${companyId}, ${mentioned}, ${`[c](project://${c})`}),
        (${companyId}, ${untouched}, 'plain comment')`;
      await sql`INSERT INTO issue_comments (company_id, issue_id, body, deleted_at) VALUES (${companyId}, ${untouched}, ${`[a](project://${a})`}, now())`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationName] });

      await applyPendingMigrations(database.connectionString);

      const rows = await sql`SELECT issue_id, source_kind, project_id FROM issue_project_references ORDER BY issue_id, source_kind, project_id`;
      expect(rows.map(row => `${row.issue_id}:${row.source_kind}:${row.project_id}`).sort()).toEqual([
        `${primaryOnly}:issue:${a}`, `${mentioned}:issue:${b}`, `${mentioned}:comment:${c}`].sort());
      expect(await sql`SELECT DISTINCT context_reference_revision AS revision FROM issues`).toEqual([{ revision: "0" }]);
      await sql`INSERT INTO issue_comments (company_id, issue_id, body) VALUES (${companyId}, ${untouched}, ${`[a](project://${a})`})`;
      expect(await sql`SELECT context_reference_revision AS revision FROM issues WHERE id = ${untouched}`).toEqual([{ revision: "1" }]);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
