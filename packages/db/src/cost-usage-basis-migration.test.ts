import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const COST_USAGE_BASIS_MIGRATION = "0180_cost_event_usage_basis.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cost usage basis migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("cost event usage basis migration source", () => {
  it("adds a non-null unknown-defaulted text column", async () => {
    const migration = await fs.promises.readFile(
      new URL(`./migrations/${COST_USAGE_BASIS_MIGRATION}`, import.meta.url),
      "utf8",
    );

    expect(migration.replace(/\s+/g, " ").trim()).toBe(
      `ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "usage_basis" text DEFAULT 'unknown' NOT NULL;`,
    );
  });
});

describeEmbeddedPostgres("cost event usage basis migration", () => {
  it(
    "backfills existing events as unknown without inferring from heartbeat runs",
    async () => {
      const db = await startEmbeddedPostgresTestDatabase("paperclip-cost-usage-basis-");
      cleanups.push(db.cleanup);
      const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const eventId = randomUUID();

      try {
        const migration = await fs.promises.readFile(
          new URL(`./migrations/${COST_USAGE_BASIS_MIGRATION}`, import.meta.url),
          "utf8",
        );
        const hash = createHash("sha256").update(migration).digest("hex");

        await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`;
        await sql`ALTER TABLE "cost_events" DROP COLUMN "usage_basis"`;
        await sql`
          INSERT INTO "companies" ("id", "name", "issue_prefix")
          VALUES (${companyId}, 'Usage Basis Company', 'UBC')
        `;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${agentId}, ${companyId}, 'Usage Basis Agent', 'engineer', 'process', '{}'::jsonb)
        `;
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status")
          VALUES (${runId}, ${companyId}, ${agentId}, 'succeeded')
        `;
        await sql`
          INSERT INTO "cost_events" (
            "id",
            "company_id",
            "agent_id",
            "heartbeat_run_id",
            "provider",
            "model",
            "cost_cents",
            "occurred_at"
          )
          VALUES (${eventId}, ${companyId}, ${agentId}, ${runId}, 'openai', 'gpt-5', 12, now())
        `;
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(db.connectionString);

      const verifySql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
      try {
        const [event] = await verifySql<{ usage_basis: string }[]>`
          SELECT "usage_basis"
          FROM "cost_events"
          WHERE "id" = ${eventId}
        `;
        expect(event?.usage_basis).toBe("unknown");

        const [column] = await verifySql<{
          is_nullable: string;
          column_default: string | null;
        }[]>`
          SELECT "is_nullable", "column_default"
          FROM "information_schema"."columns"
          WHERE "table_schema" = 'public'
            AND "table_name" = 'cost_events'
            AND "column_name" = 'usage_basis'
        `;
        expect(column?.is_nullable).toBe("NO");
        expect(column?.column_default).toContain("unknown");
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );
});
