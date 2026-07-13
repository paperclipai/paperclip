import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const ISSUE_ID_INDEX_MIGRATION = "0147_jsonb_issue_id_expression_indexes.sql";
const HEARTBEAT_RUNS_INDEX = "heartbeat_runs_company_context_issue_idx";
const WAKEUP_REQUESTS_INDEX = "agent_wakeup_requests_company_payload_issue_idx";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-jsonb-issue-idx-");
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

async function makeIssueIdIndexMigrationPending(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const hash = await migrationHash(ISSUE_ID_INDEX_MIGRATION);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${hash}
  `;
}

async function dropIssueIdIndexes(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "heartbeat_runs_company_context_issue_idx"`;
  await sql`DROP INDEX IF EXISTS "agent_wakeup_requests_company_payload_issue_idx"`;
}

async function createSeedGraph(sql: ReturnType<typeof postgres>, label: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();

  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, ${`Company ${label}`}, ${`T${label}`})
  `;
  await sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
    VALUES (${agentId}, ${companyId}, ${`Agent ${label}`}, 'engineer', 'process', '{}'::jsonb)
  `;
  await sql`
    INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "context_snapshot")
    VALUES (${randomUUID()}, ${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId })})
  `;
  await sql`
    INSERT INTO "agent_wakeup_requests" ("id", "company_id", "agent_id", "source", "payload")
    VALUES (${randomUUID()}, ${companyId}, ${agentId}, 'issue_event', ${sql.json({ issueId })})
  `;

  return { companyId, agentId, issueId };
}

async function expectIssueIdIndexes(sql: ReturnType<typeof postgres>): Promise<void> {
  const indexes = await sql<{ indexname: string; indexdef: string }[]>`
    SELECT "indexname", "indexdef"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" IN (${HEARTBEAT_RUNS_INDEX}, ${WAKEUP_REQUESTS_INDEX})
    ORDER BY "indexname"
  `;
  expect(indexes).toEqual([
    {
      indexname: WAKEUP_REQUESTS_INDEX,
      indexdef: expect.stringContaining("(company_id, ((payload ->> 'issueId'::text)))"),
    },
    {
      indexname: HEARTBEAT_RUNS_INDEX,
      indexdef: expect.stringContaining("(company_id, ((context_snapshot ->> 'issueId'::text)))"),
    },
  ]);
}

async function expectIndexScanForIssueLookups(
  sql: ReturnType<typeof postgres>,
  companyId: string,
  issueId: string,
): Promise<void> {
  // Tiny test tables always favor a seq scan, so disable it for this session
  // to prove the index expression matches the predicate shape used by the
  // heartbeat/wake query sites.
  await sql`SET enable_seqscan = off`;
  const runPlan = await sql.unsafe(
    `EXPLAIN (FORMAT JSON) SELECT "id" FROM "heartbeat_runs" WHERE "company_id" = '${companyId}' AND "context_snapshot" ->> 'issueId' = '${issueId}'`,
  );
  expect(JSON.stringify(runPlan)).toContain(HEARTBEAT_RUNS_INDEX);

  const wakePlan = await sql.unsafe(
    `EXPLAIN (FORMAT JSON) SELECT "id" FROM "agent_wakeup_requests" WHERE "company_id" = '${companyId}' AND "payload" ->> 'issueId' = '${issueId}'`,
  );
  expect(JSON.stringify(wakePlan)).toContain(WAKEUP_REQUESTS_INDEX);
  await sql`RESET enable_seqscan`;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres jsonb issueId index migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("jsonb issueId expression index migration", () => {
  it(
    "fresh installs create both expression indexes and they serve issue-scoped lookups",
    async () => {
      const connectionString = await createTempDatabase();
      const state = await inspectMigrations(connectionString);

      expect(state.status).toBe("upToDate");
      expect(state.availableMigrations).toContain(ISSUE_ID_INDEX_MIGRATION);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await expectIssueIdIndexes(sql);
        const { companyId, issueId } = await createSeedGraph(sql, "FRESH");
        await expectIndexScanForIssueLookups(sql, companyId, issueId);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "adds the indexes to an existing database that already has run and wake data",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await dropIssueIdIndexes(sql);
        await makeIssueIdIndexMigrationPending(sql);
        await createSeedGraph(sql, "UPGRADE");
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [ISSUE_ID_INDEX_MIGRATION],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await expectIssueIdIndexes(verifySql);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "is idempotent when the indexes already exist",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await makeIssueIdIndexMigrationPending(sql);
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await expectIssueIdIndexes(verifySql);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );
});
