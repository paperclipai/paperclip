import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationName = "0439_task_project_references.sql";
const migrationHash = createHash("sha256").update(await readFile(new URL(`./migrations/${migrationName}`, import.meta.url), "utf8")).digest("hex");
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("task project references migration", () => {
  it("backfills candidates for existing tasks and projects later writes without locking the task", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-task-project-references-migration-");
    const sql = postgres(database.connectionString, { max: 2, onnotice: () => {} });
    try {
      await sql`DROP TABLE issue_project_references`;
      await sql`DROP FUNCTION paperclip_issue_project_references, paperclip_deleted_issue_project_references,
        paperclip_document_body_project_references, paperclip_issue_document_project_references, paperclip_row_project_references,
        paperclip_sync_project_reference_sources, paperclip_project_reference_candidates CASCADE`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      const companyId = randomUUID(), [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
      const [primaryOnly, mentioned, untouched] = [randomUUID(), randomUUID(), randomUUID()];
      const [documentId, revisionId, interactionId, commentId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Upgrade', 'UPR')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${a}, ${companyId}, 'A'), (${b}, ${companyId}, 'B')`;
      await sql`INSERT INTO issues (id, company_id, title, project_id, description) VALUES
        (${primaryOnly}, ${companyId}, 'Primary', ${a}, null),
        (${mentioned}, ${companyId}, 'Mentions', null, ${`[b](project://${b})`}),
        (${untouched}, ${companyId}, 'Plain', null, 'no links')`;
      await sql`INSERT INTO issue_comments (id, company_id, issue_id, body) VALUES (${randomUUID()}, ${companyId}, ${mentioned}, ${`[c](project://${c})`}),
        (${commentId}, ${companyId}, ${untouched}, 'plain comment')`;
      await sql`INSERT INTO issue_comments (company_id, issue_id, body, deleted_at) VALUES (${companyId}, ${untouched}, ${`[a](project://${a})`}, now())`;
      // An accepted plan revision that the latest plan body no longer mentions.
      await sql`INSERT INTO documents (id, company_id, title, latest_body) VALUES (${documentId}, ${companyId}, 'Plan', 'latest')`;
      await sql`INSERT INTO document_revisions (id, company_id, document_id, revision_number, body) VALUES
        (${revisionId}, ${companyId}, ${documentId}, 1, ${`[d](project://${d})`})`;
      await sql`INSERT INTO issue_documents (company_id, issue_id, document_id, key) VALUES (${companyId}, ${mentioned}, ${documentId}, 'plan')`;
      await sql`INSERT INTO issue_thread_interactions (id, company_id, issue_id, kind, status, payload) VALUES (${interactionId}, ${companyId},
        ${mentioned}, 'request_confirmation', 'accepted', ${sql.json({ version: 1, prompt: "Accept?",
          target: { type: "issue_document", issueId: mentioned, documentId, key: "plan", revisionId, revisionNumber: 1 } })})`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationName] });

      await applyPendingMigrations(database.connectionString);

      const rows = async () => (await sql`SELECT issue_id, source_kind, project_id FROM issue_project_references`)
        .map(row => `${row.issue_id}:${row.source_kind}:${row.project_id}`).sort();
      expect(await rows()).toEqual([`${primaryOnly}:issue:${a}`, `${mentioned}:issue:${b}`, `${mentioned}:comment:${c}`,
        `${mentioned}:accepted_plan:${d}`].sort());
      // Another transaction holds the task FOR UPDATE; a source write still projects without waiting on it.
      const locker = await sql.reserve();
      try {
        await locker`BEGIN`;
        await locker`SELECT id FROM issues WHERE id = ${untouched} FOR UPDATE`;
        await sql.begin(async tx => {
          await tx`SET LOCAL lock_timeout = '2s'`;
          await tx`UPDATE issue_comments SET body = ${`[a](project://${a})`} WHERE id = ${commentId}`;
        });
      } finally {
        await locker`ROLLBACK`;
        locker.release();
      }
      expect(await rows()).toContain(`${untouched}:comment:${a}`);
      await sql`DELETE FROM issues WHERE id = ${untouched}`;
      expect((await rows()).some(row => row.startsWith(untouched))).toBe(false);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
