import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0195_issue_version.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-issue-version-migration-");
  cleanups.push(database.cleanup);
  return database.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue version migration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue version migration", () => {
  it(
    "backfills existing issues, defaults new issues, and enforces a positive version",
    async () => {
      const connectionString = await createTempDatabase();
      const migrationContent = await fs.promises.readFile(
        new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
        "utf8",
      );
      const migrationHash = createHash("sha256").update(migrationContent).digest("hex");
      const companyId = randomUUID();
      const existingIssueId = randomUUID();
      const newIssueId = randomUUID();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

      try {
        await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
        await sql`ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_version_positive"`;
        await sql`ALTER TABLE "issues" DROP COLUMN IF EXISTS "version"`;
        await sql`
          INSERT INTO "companies" ("id", "name", "issue_prefix")
          VALUES (${companyId}, 'Issue version migration company', 'IVM')
        `;
        await sql`
          INSERT INTO "issues" ("id", "company_id", "title", "identifier")
          VALUES (${existingIssueId}, ${companyId}, 'Pre-migration issue', 'IVM-1')
        `;
      } finally {
        await sql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const existingIssues = await verifySql<{ version: number }[]>`
          SELECT "version" FROM "issues" WHERE "id" = ${existingIssueId}
        `;
        expect(existingIssues).toEqual([{ version: 1 }]);

        await verifySql`
          INSERT INTO "issues" ("id", "company_id", "title", "identifier")
          VALUES (${newIssueId}, ${companyId}, 'New issue', 'IVM-2')
        `;
        const newIssues = await verifySql<{ version: number }[]>`
          SELECT "version" FROM "issues" WHERE "id" = ${newIssueId}
        `;
        expect(newIssues).toEqual([{ version: 1 }]);

        for (const invalidVersion of [0, -1]) {
          await expect(
            verifySql`UPDATE "issues" SET "version" = ${invalidVersion} WHERE "id" = ${newIssueId}`,
          ).rejects.toThrow(/issues_version_positive/);
        }

        const appliedMigrations = await verifySql<{ hash: string }[]>`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = ${migrationHash}
        `;
        expect(appliedMigrations).toEqual([{ hash: migrationHash }]);
      } finally {
        await verifySql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({
        status: "upToDate",
        appliedMigrations: expect.arrayContaining([MIGRATION_FILE]),
      });
    },
    60_000,
  );
});
