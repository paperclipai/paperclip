import fs from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0295_backfill_built_in_bundles_responsible_user.sql";
const MARKER = "built-in-bundles";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function readMigration(): Promise<string> {
  return fs.promises.readFile(new URL(`./migrations/${MIGRATION}`, import.meta.url), "utf8");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping built-in bundle responsible-user migration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("built-in bundle responsible-user backfill", () => {
  it("replaces the marker with the company default and is idempotent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-backfill-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix", "default_responsible_user_id")
        VALUES (${companyId}, 'Backfill Co', 'BFC', 'owner-user')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name")
        VALUES (${agentId}, ${companyId}, 'Built-in')
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;
      await sql`
        INSERT INTO "routine_revisions" (
          "id", "company_id", "routine_id", "revision_number", "title", "snapshot", "responsible_user_id"
        ) VALUES (${randomUUID()}, ${companyId}, ${routineId}, 1, 'Bundle routine', '{}'::jsonb, ${MARKER})
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${issueId}, ${companyId}, 'Bundle issue', ${MARKER})
      `;
      await sql`
        INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "responsible_user_id")
        VALUES (${runId}, ${companyId}, ${agentId}, ${MARKER})
      `;

      const migration = await readMigration();
      await sql.unsafe(migration);
      await sql.unsafe(migration);

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      const revisions = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routine_revisions" WHERE "routine_id" = ${routineId}
      `;
      const issues = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "issues" WHERE "id" = ${issueId}
      `;
      const runs = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "heartbeat_runs" WHERE "id" = ${runId}
      `;

      expect(routines[0]?.responsible_user_id).toBe("owner-user");
      expect(revisions[0]?.responsible_user_id).toBe("owner-user");
      expect(issues[0]?.responsible_user_id).toBe("owner-user");
      expect(runs[0]?.responsible_user_id).toBe("owner-user");
    } finally {
      await sql.end();
    }
  });

  it("falls back to the oldest active owner when the company default is unset", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-fallback-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'No Default Co', 'NDC')
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status", "membership_role", "created_at"
        ) VALUES
          (${companyId}, 'user', 'member-user', 'active', 'member', now() - interval '2 days'),
          (${companyId}, 'user', 'owner-user', 'active', 'owner', now() - interval '1 day')
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;

      await sql.unsafe(await readMigration());

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      expect(routines[0]?.responsible_user_id).toBe("owner-user");
    } finally {
      await sql.end();
    }
  });

  it("ignores a whitespace-only default and uses the owner fallback instead", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-blank-default-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix", "default_responsible_user_id")
        VALUES (${companyId}, 'Blank Default Co', 'BLD', '   ')
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status", "membership_role", "created_at"
        ) VALUES (${companyId}, 'user', 'owner-user', 'active', 'owner', now())
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;

      await sql.unsafe(await readMigration());

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      expect(routines[0]?.responsible_user_id).toBe("owner-user");
    } finally {
      await sql.end();
    }
  });

  it("prefers an owner over an older member with a null role", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-owner-precedence-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Owner Precedence Co', 'OPC')
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status", "membership_role", "created_at"
        ) VALUES
          (${companyId}, 'user', 'null-role-user', 'active', NULL, now() - interval '2 days'),
          (${companyId}, 'user', 'owner-user', 'active', 'owner', now() - interval '1 day')
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;

      await sql.unsafe(await readMigration());

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      expect(routines[0]?.responsible_user_id).toBe("owner-user");
    } finally {
      await sql.end();
    }
  });

  it("skips a viewer member and falls back to a non-viewer member", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-viewer-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Viewer Co', 'VWR')
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status", "membership_role", "created_at"
        ) VALUES
          (${companyId}, 'user', 'viewer-user', 'active', 'viewer', now() - interval '2 days'),
          (${companyId}, 'user', 'operator-user', 'active', 'operator', now() - interval '1 day')
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;

      await sql.unsafe(await readMigration());

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      expect(routines[0]?.responsible_user_id).toBe("operator-user");
    } finally {
      await sql.end();
    }
  });

  it("leaves the marker untouched when no real user can be resolved", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bundles-unresolved-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const routineId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Empty Co', 'EMP')
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "responsible_user_id")
        VALUES (${routineId}, ${companyId}, 'Bundle routine', ${MARKER})
      `;

      await sql.unsafe(await readMigration());

      const routines = await sql<{ responsible_user_id: string }[]>`
        SELECT "responsible_user_id" FROM "routines" WHERE "id" = ${routineId}
      `;
      expect(routines[0]?.responsible_user_id).toBe(MARKER);
    } finally {
      await sql.end();
    }
  });
});
