import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const LAST_ACTIVITY_MIGRATION = "0284_issue_last_activity_at.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-last-activity-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Put the database back in the shape it had immediately before this migration
 * ran, so the migration itself — triggers and backfill included — is what the
 * assertions exercise.
 */
async function rewindLastActivityMigration(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const hash = await migrationHash(LAST_ACTIVITY_MIGRATION);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`;
  await sql`DROP TRIGGER IF EXISTS paperclip_issue_last_activity_trigger ON "issues"`;
  await sql`DROP TRIGGER IF EXISTS paperclip_issue_comment_last_activity_trigger ON "issue_comments"`;
  await sql`DROP TRIGGER IF EXISTS paperclip_activity_log_issue_last_activity_trigger ON "activity_log"`;
  await sql`DROP INDEX IF EXISTS "issues_company_last_activity_idx"`;
  await sql`ALTER TABLE "issues" DROP COLUMN IF EXISTS "last_activity_at"`;
}

async function createSeedGraph(sql: ReturnType<typeof postgres>, label: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();

  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, ${`Company ${label}`}, ${`T${label}`})
  `;
  await sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
    VALUES (${agentId}, ${companyId}, ${`Agent ${label}`}, 'engineer', 'process', '{}'::jsonb)
  `;

  return { companyId, agentId };
}

async function insertIssue(
  sql: ReturnType<typeof postgres>,
  companyId: string,
  identifier: string,
  updatedAt: string,
): Promise<string> {
  const issueId = randomUUID();
  await sql`
    INSERT INTO "issues" ("id", "company_id", "title", "identifier", "created_at", "updated_at")
    VALUES (${issueId}, ${companyId}, ${identifier}, ${identifier}, ${updatedAt}, ${updatedAt})
  `;
  return issueId;
}

async function lastActivityAt(
  sql: ReturnType<typeof postgres>,
  issueId: string,
): Promise<Date | null> {
  const [row] = await sql<{ last_activity_at: Date | null }[]>`
    SELECT "last_activity_at" FROM "issues" WHERE "id" = ${issueId}
  `;
  return row?.last_activity_at ?? null;
}

/**
 * The transaction id that wrote the row's current tuple version. It changes on
 * every physical write of the row — including a write that sets a column to the
 * value it already holds — so it is what proves the forward-only guards in the
 * comment and activity-log triggers really skip the no-op UPDATE rather than
 * writing a fresh, identical tuple (a dead tuple plus a touch of every index on
 * "issues").
 */
async function issueXmin(
  sql: ReturnType<typeof postgres>,
  issueId: string,
): Promise<string> {
  const [row] = await sql<{ xmin: string }[]>`
    SELECT "xmin"::text AS "xmin" FROM "issues" WHERE "id" = ${issueId}
  `;
  return row!.xmin;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres last-activity migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issues.last_activity_at migration", () => {
  it(
    "installs the column, the reader index and the three maintaining triggers, and drops its own backfill support index",
    async () => {
      const connectionString = await createTempDatabase();
      const state = await inspectMigrations(connectionString);
      expect(state.status).toBe("upToDate");
      expect(state.availableMigrations).toContain(LAST_ACTIVITY_MIGRATION);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await sql<{ data_type: string; is_nullable: string }[]>`
          SELECT "data_type", "is_nullable"
          FROM "information_schema"."columns"
          WHERE "table_schema" = 'public'
            AND "table_name" = 'issues'
            AND "column_name" = 'last_activity_at'
        `;
        expect(columns).toEqual([
          { data_type: "timestamp with time zone", is_nullable: "YES" },
        ]);

        const triggers = await sql<{ tgname: string; relname: string }[]>`
          SELECT t."tgname", c."relname"
          FROM "pg_trigger" t
          JOIN "pg_class" c ON c."oid" = t."tgrelid"
          WHERE NOT t."tgisinternal"
            AND t."tgname" IN (
              'paperclip_issue_last_activity_trigger',
              'paperclip_issue_comment_last_activity_trigger',
              'paperclip_activity_log_issue_last_activity_trigger'
            )
          ORDER BY t."tgname"
        `;
        expect(triggers).toEqual([
          {
            tgname: "paperclip_activity_log_issue_last_activity_trigger",
            relname: "activity_log",
          },
          {
            tgname: "paperclip_issue_comment_last_activity_trigger",
            relname: "issue_comments",
          },
          { tgname: "paperclip_issue_last_activity_trigger", relname: "issues" },
        ]);

        const indexes = await sql<{ indexname: string }[]>`
          SELECT "indexname"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
            AND "indexname" IN (
              'issues_company_last_activity_idx',
              'issues_last_activity_backfill_idx'
            )
          ORDER BY "indexname"
        `;
        expect(indexes).toEqual([
          { indexname: "issues_company_last_activity_idx" },
        ]);
      } finally {
        await sql.end();
      }
    },
    30_000,
  );

  it(
    "keeps the column current: comments and non-inbox log rows raise it, inbox bookkeeping does not, and it never moves backwards",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const { companyId, agentId } = await createSeedGraph(sql, "LIVE");
        const issueId = await insertIssue(
          sql,
          companyId,
          "TLIVE-1",
          "2026-01-01T00:00:00Z",
        );

        // The issue trigger seeds the column from the row's own updated_at.
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-01-01T00:00:00Z"),
        );

        // A comment raises it without touching updated_at.
        await sql`
          INSERT INTO "issue_comments" ("company_id", "issue_id", "author_agent_id", "body", "created_at")
          VALUES (${companyId}, ${issueId}, ${agentId}, 'a comment', '2026-02-01T00:00:00Z')
        `;
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-02-01T00:00:00Z"),
        );
        const [afterComment] = await sql<{ updated_at: Date }[]>`
          SELECT "updated_at" FROM "issues" WHERE "id" = ${issueId}
        `;
        expect(afterComment!.updated_at).toEqual(new Date("2026-01-01T00:00:00Z"));

        // A real activity-log row raises it.
        await sql`
          INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
          VALUES (${companyId}, ${agentId}, 'issue.updated', 'issue', ${issueId}, '2026-03-01T00:00:00Z')
        `;
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-03-01T00:00:00Z"),
        );

        // Per-reader inbox bookkeeping is not activity on the issue.
        for (const action of [
          "issue.read_marked",
          "issue.read_unmarked",
          "issue.inbox_archived",
          "issue.inbox_unarchived",
        ]) {
          await sql`
            INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
            VALUES (${companyId}, ${agentId}, ${action}, 'issue', ${issueId}, '2026-04-01T00:00:00Z')
          `;
        }
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-03-01T00:00:00Z"),
        );

        // A non-uuid entity_id is simply not matched — the log insert stands.
        await sql`
          INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
          VALUES (${companyId}, ${agentId}, 'issue.updated', 'issue', 'not-a-uuid', '2026-05-01T00:00:00Z')
        `;
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-03-01T00:00:00Z"),
        );

        // Activity that is older than what the column already holds is a
        // no-op, and must not cost a tuple write on the issue row: same xmin
        // before and after, for both AFTER triggers.
        const xminBeforeStaleActivity = await issueXmin(sql, issueId);
        await sql`
          INSERT INTO "issue_comments" ("company_id", "issue_id", "author_agent_id", "body", "created_at")
          VALUES (${companyId}, ${issueId}, ${agentId}, 'a late-arriving older comment', '2026-02-10T00:00:00Z')
        `;
        await sql`
          INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
          VALUES (${companyId}, ${agentId}, 'issue.updated', 'issue', ${issueId}, '2026-02-20T00:00:00Z')
        `;
        expect(await issueXmin(sql, issueId)).toBe(xminBeforeStaleActivity);
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-03-01T00:00:00Z"),
        );

        // An ordinary issue UPDATE with an older updated_at must not undo the
        // comment and log activity recorded above.
        await sql`
          UPDATE "issues" SET "title" = 'renamed', "updated_at" = '2026-02-15T00:00:00Z'
          WHERE "id" = ${issueId}
        `;
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-03-01T00:00:00Z"),
        );

        // A newer updated_at does raise it.
        await sql`
          UPDATE "issues" SET "updated_at" = '2026-06-01T00:00:00Z' WHERE "id" = ${issueId}
        `;
        expect(await lastActivityAt(sql, issueId)).toEqual(
          new Date("2026-06-01T00:00:00Z"),
        );
      } finally {
        await sql.end();
      }
    },
    30_000,
  );

  it(
    "backfills pre-existing rows to exactly what the previous per-query expression computed",
    async () => {
      const connectionString = await createTempDatabase();
      const seedSql = postgres(connectionString, { max: 1, onnotice: () => {} });
      let companyId = "";
      try {
        await rewindLastActivityMigration(seedSql);
        ({ companyId } = await createSeedGraph(seedSql, "BACK"));
        const { agentId } = await createSeedGraph(seedSql, "OTHER");

        for (let index = 0; index < 40; index += 1) {
          const issueId = await insertIssue(
            seedSql,
            companyId,
            `TBACK-${index}`,
            `2026-01-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`,
          );
          if (index % 3 === 0) {
            await seedSql`
              INSERT INTO "issue_comments" ("company_id", "issue_id", "body", "created_at")
              VALUES (${companyId}, ${issueId}, ${`comment ${index}`}, ${`2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`})
            `;
          }
          if (index % 4 === 0) {
            await seedSql`
              INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
              VALUES (${companyId}, ${agentId}, 'issue.updated', 'issue', ${issueId}, ${`2026-03-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`})
            `;
          }
          if (index % 5 === 0) {
            // Inbox bookkeeping, deliberately newer than everything else: the
            // backfill must ignore it exactly as the reader expression did.
            await seedSql`
              INSERT INTO "activity_log" ("company_id", "actor_id", "action", "entity_type", "entity_id", "created_at")
              VALUES (${companyId}, ${agentId}, 'issue.read_marked', 'issue', ${issueId}, '2026-12-01T00:00:00Z')
            `;
          }
        }
      } finally {
        await seedSql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [LAST_ACTIVITY_MIGRATION],
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // The oracle: the expression the issue list evaluated per row, per
        // query, before this migration. Every backfilled row must equal it.
        const mismatches = await verifySql<{ count: string }[]>`
          SELECT COUNT(*)::text AS "count"
          FROM "issues" i
          WHERE i."company_id" = ${companyId}
            AND i."last_activity_at" IS DISTINCT FROM GREATEST(
              i."updated_at",
              COALESCE((
                SELECT MAX(c."created_at")
                FROM "issue_comments" c
                WHERE c."issue_id" = i."id" AND c."company_id" = i."company_id"
              ), to_timestamp(0)),
              COALESCE((
                SELECT MAX(a."created_at")
                FROM "activity_log" a
                WHERE a."company_id" = i."company_id"
                  AND a."entity_type" = 'issue'
                  AND a."entity_id" = i."id"::text
                  AND a."action" NOT IN (
                    'issue.read_marked',
                    'issue.read_unmarked',
                    'issue.inbox_archived',
                    'issue.inbox_unarchived'
                  )
              ), to_timestamp(0))
            )
        `;
        expect(mismatches[0]!.count).toBe("0");

        const nulls = await verifySql<{ count: string }[]>`
          SELECT COUNT(*)::text AS "count"
          FROM "issues" WHERE "last_activity_at" IS NULL
        `;
        expect(nulls[0]!.count).toBe("0");
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    60_000,
  );
});
