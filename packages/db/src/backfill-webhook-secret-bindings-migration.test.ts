import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0227_backfill_webhook_secret_bindings.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backfill webhook secret bindings migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("backfill webhook secret bindings migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it(
    "creates missing bindings for legacy webhook triggers (enabled and disabled) and is idempotent",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-backfill-webhook-bindings-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end());

      const companyId = randomUUID();
      // Each webhook trigger lives on its own routine, mirroring how
      // services/routines.ts writes bindings with target_id=routine_id.
      const enabledRoutineId = randomUUID();
      const disabledRoutineId = randomUUID();
      const alreadyBoundRoutineId = randomUUID();
      const enabledSecretId = randomUUID();
      const disabledSecretId = randomUUID();
      const alreadyBoundSecretId = randomUUID();
      const enabledTriggerId = randomUUID();
      const disabledTriggerId = randomUUID();
      const alreadyBoundTriggerId = randomUUID();

      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Backfill webhook company', 'BWH')
      `;
      for (const routineId of [enabledRoutineId, disabledRoutineId, alreadyBoundRoutineId]) {
        await sql`
          INSERT INTO "routines" (
            "id", "company_id", "title"
          ) VALUES (
            ${routineId}, ${companyId}, ${`Legacy routine ${routineId}`}
          )
        `;
      }
      for (const secretId of [enabledSecretId, disabledSecretId, alreadyBoundSecretId]) {
        await sql`
          INSERT INTO "company_secrets" (
            "id", "company_id", "key", "name"
          ) VALUES (
            ${secretId}, ${companyId}, ${`webhookSecret:${secretId}`}, ${`webhook-${secretId}`}
          )
        `;
      }
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${enabledTriggerId}, ${companyId}, ${enabledRoutineId}, 'webhook', true, ${enabledSecretId}
        )
      `;
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${disabledTriggerId}, ${companyId}, ${disabledRoutineId}, 'webhook', false, ${disabledSecretId}
        )
      `;
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${alreadyBoundTriggerId}, ${companyId}, ${alreadyBoundRoutineId}, 'webhook', true, ${alreadyBoundSecretId}
        )
      `;
      // Pre-existing binding for the third trigger, shaped exactly like
      // services/routines.ts writes for new triggers (target_id=routine_id).
      // The backfill must skip it rather than create a duplicate or raise a
      // unique-violation.
      await sql`
        INSERT INTO "company_secret_bindings" (
          "company_id", "secret_id", "target_type", "target_id", "config_path"
        ) VALUES (
          ${companyId}, ${alreadyBoundSecretId}, 'routine', ${alreadyBoundRoutineId},
          ${`webhookSecret:${alreadyBoundSecretId}`}
        )
      `;
      // Remove any bindings the current schema may have auto-created for the
      // legacy triggers, so we reproduce the pre-enforcement instance state.
      await sql`
        DELETE FROM "company_secret_bindings"
        WHERE "secret_id" IN (${enabledSecretId}, ${disabledSecretId})
      `;

      const hash = await migrationHash();
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;

      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

      const bindings = await sql<
        { secret_id: string; target_id: string; config_path: string }[]
      >`
        SELECT "secret_id", "target_id", "config_path"
        FROM "company_secret_bindings"
        WHERE "company_id" = ${companyId}
        ORDER BY "secret_id"
      `;
      // One backfilled row per legacy trigger (enabled + disabled) plus the
      // pre-existing binding for the already-bound trigger. Total: three.
      expect(bindings).toHaveLength(3);

      const bySecret = new Map(bindings.map((row) => [row.secret_id, row]));
      expect(bySecret.get(enabledSecretId)).toEqual({
        secret_id: enabledSecretId,
        target_id: enabledRoutineId,
        config_path: `webhookSecret:${enabledSecretId}`,
      });
      // Disabled triggers must be backfilled too, otherwise re-enabling one
      // would reintroduce the 422 binding_missing regression.
      expect(bySecret.get(disabledSecretId)).toEqual({
        secret_id: disabledSecretId,
        target_id: disabledRoutineId,
        config_path: `webhookSecret:${disabledSecretId}`,
      });
      expect(bySecret.get(alreadyBoundSecretId)).toEqual({
        secret_id: alreadyBoundSecretId,
        target_id: alreadyBoundRoutineId,
        config_path: `webhookSecret:${alreadyBoundSecretId}`,
      });

      // Idempotency: replay the migration a second time and expect no new
      // rows (NOT EXISTS guard + ON CONFLICT DO NOTHING).
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      const afterReplay = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM "company_secret_bindings"
        WHERE "company_id" = ${companyId}
      `;
      expect(afterReplay[0]?.count).toBe(3);
    },
    45_000,
  );
});
