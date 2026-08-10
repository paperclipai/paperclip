import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0195_built_in_agent_unique_marker.sql";
const UNIQUE_INDEX = "agents_company_built_in_agent_key_unique_idx";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

function markerObj(key: string) {
  // Return a plain object (not a JSON string) so `sql.json` stores it as a jsonb
  // object; a JSON string param + `::jsonb` would double-encode into a scalar.
  return { paperclipBuiltInAgent: { key, featureKeys: [key] } };
}

describeEmbeddedPostgres("built-in agent unique marker migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("resolves pre-existing duplicates and enforces uniqueness going forward", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-built-in-unique-marker-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind the migration so we can seed the pre-index (duplicate) state.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP INDEX IF EXISTS ${sql(UNIQUE_INDEX)}`;

    const affectedCompanyId = randomUUID();
    const cleanCompanyId = randomUUID();
    const olderId = randomUUID();
    const newerId = randomUUID();
    const terminatedDupeId = randomUUID();
    const cleanSummarizerId = randomUUID();
    const approvalId = randomUUID();
    const apiKeyId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES
        (${affectedCompanyId}, 'Affected', 'AFF'),
        (${cleanCompanyId}, 'Clean', 'CLN')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status", "created_at", "metadata")
      VALUES
        (${olderId}, ${affectedCompanyId}, 'Summarizer One', 'idle', '2026-07-18T00:00:00.000Z', ${sql.json(markerObj("summarizer"))}),
        (${newerId}, ${affectedCompanyId}, 'Summarizer Two', 'pending_approval', '2026-07-18T00:00:00.025Z', ${sql.json(markerObj("summarizer"))}),
        (${terminatedDupeId}, ${affectedCompanyId}, 'Summarizer Old', 'terminated', '2026-07-17T00:00:00.000Z', ${sql.json(markerObj("summarizer"))}),
        (${cleanSummarizerId}, ${cleanCompanyId}, 'Summarizer', 'idle', '2026-07-18T00:00:00.000Z', ${sql.json(markerObj("summarizer"))})
    `;
    await sql`
      INSERT INTO "approvals" ("id", "company_id", "type", "status", "payload")
      VALUES (${approvalId}, ${affectedCompanyId}, 'hire_agent', 'pending', ${sql.json({ agentId: newerId, sourceBuiltInAgentKey: "summarizer" })})
    `;
    await sql`
      INSERT INTO "agent_api_keys" ("id", "agent_id", "company_id", "name", "key_hash")
      VALUES (${apiKeyId}, ${newerId}, ${affectedCompanyId}, 'dupe-key', 'hash')
    `;

    // Re-run the migration: it should clean up the duplicates, then recreate the index.
    await applyPendingMigrations(database.connectionString);

    const agentRows = await sql<{ id: string; status: string }[]>`
      SELECT "id", "status" FROM "agents"
      WHERE "company_id" IN (${affectedCompanyId}, ${cleanCompanyId})
    `;
    const statusById = new Map(agentRows.map((row) => [row.id, row.status]));
    // Oldest active row kept; newer duplicate terminated; the clean company untouched.
    expect(statusById.get(olderId)).toBe("idle");
    expect(statusById.get(newerId)).toBe("terminated");
    expect(statusById.get(cleanSummarizerId)).toBe("idle");

    const activeMarked = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM "agents"
      WHERE "company_id" = ${affectedCompanyId}
        AND "status" <> 'terminated'
        AND ("metadata" -> 'paperclipBuiltInAgent' ->> 'key') = 'summarizer'
    `;
    expect(activeMarked[0]!.count).toBe("1");

    // The newer duplicate's orphan approval was cancelled and its API key revoked.
    const [approval] = await sql<{ status: string }[]>`
      SELECT "status" FROM "approvals" WHERE "id" = ${approvalId}
    `;
    expect(approval!.status).toBe("cancelled");
    const [apiKey] = await sql<{ revoked_at: Date | null }[]>`
      SELECT "revoked_at" FROM "agent_api_keys" WHERE "id" = ${apiKeyId}
    `;
    expect(apiKey!.revoked_at).not.toBeNull();

    // The partial unique index exists again and now rejects a second active row.
    const indexes = await sql<{ indexname: string }[]>`
      SELECT "indexname" FROM "pg_indexes"
      WHERE "tablename" = 'agents' AND "indexname" = ${UNIQUE_INDEX}
    `;
    expect(indexes).toHaveLength(1);
    await expect(
      sql`
        INSERT INTO "agents" ("id", "company_id", "name", "status", "metadata")
        VALUES (${randomUUID()}, ${affectedCompanyId}, 'Summarizer Dupe', 'idle', ${sql.json(markerObj("summarizer"))})
      `,
    ).rejects.toMatchObject({ code: "23505", constraint_name: UNIQUE_INDEX });
  }, 30_000);
});
