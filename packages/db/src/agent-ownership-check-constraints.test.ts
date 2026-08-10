import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import {
  AGENT_OWNERSHIP_PRINCIPAL_TYPES,
  AGENT_OWNERSHIP_ROLES,
  AGENT_OWNERSHIP_SOURCES,
} from "./schema/agent_ownership_grants.js";

/**
 * TECH-4929: `AGENT_OWNERSHIP_PRINCIPAL_TYPES`, `AGENT_OWNERSHIP_ROLES`, and
 * `AGENT_OWNERSHIP_SOURCES` (packages/db/src/schema/agent_ownership_grants.ts)
 * exist to give bad values a compile-time error instead of an opaque CHECK
 * failure at write time. That guarantee only holds if those TS unions stay
 * byte-for-byte in sync with the CHECK constraints actually enforced in
 * Postgres (0212_broken_ares.sql). Nothing else keeps them in
 * sync -- a comment would only catch drift someone remembers to read. This
 * test introspects `pg_constraint` on a real embedded Postgres instance
 * after running the migrations, and fails loudly the moment the two sides
 * disagree.
 */

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent ownership CHECK-constraint drift test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Extracts the quoted string literals out of a `pg_get_constraintdef`
 * rendering of a `column = ANY (ARRAY['a'::text, 'b'::text, ...])` CHECK
 * constraint, in the order Postgres prints them.
 *
 * Postgres canonicalises a schema-authored `column in ('a', 'b', ...)`
 * CHECK constraint into `column = ANY (ARRAY['a'::text, 'b'::text, ...])`
 * at creation time -- verified against a real embedded-Postgres instance
 * for all three constraints this test covers. That rendering is not
 * documented as a guarantee, so this function asserts the shape it
 * depends on before parsing: a Postgres upgrade that changes the
 * canonical form must fail this test loudly, rather than have the regex
 * silently match nothing and the `toEqual([])` comparison below pass
 * vacuously against an empty `AGENT_OWNERSHIP_*` array.
 */
function extractAllowedValues(constraintDef: string): string[] {
  if (!/=\s*ANY\s*\(\s*ARRAY\[/.test(constraintDef)) {
    throw new Error(
      `Expected a "column = ANY (ARRAY[...])" CHECK constraint rendering, got: ${constraintDef}. ` +
        "Postgres's canonical rendering of an `IN (...)` CHECK constraint may have changed; " +
        "update extractAllowedValues to match the new form.",
    );
  }

  const matches = Array.from(constraintDef.matchAll(/'([^']*)'::text/g), (m) => m[1]);
  if (matches.length === 0) {
    throw new Error(`Matched the "= ANY (ARRAY[...])" shape but extracted zero values from: ${constraintDef}`);
  }
  return matches;
}

describeEmbeddedPostgres("agent ownership CHECK constraints vs TS constants", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it(
    "agrees with AGENT_OWNERSHIP_PRINCIPAL_TYPES, AGENT_OWNERSHIP_ROLES, and AGENT_OWNERSHIP_SOURCES",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-agent-ownership-check-constraints-");
      const sql = postgres(database.connectionString, { max: 1 });
      // Sequenced, not `Promise.all([sql.end(), database.cleanup])`: the pg
      // client must finish closing its connection before the embedded
      // Postgres process is stopped, or stopping the process can race an
      // in-flight client shutdown.
      // try/finally so a throwing sql.end() can't leak the Postgres process.
      cleanups.push(async () => {
        try {
          await sql.end();
        } finally {
          await database.cleanup();
        }
      });

      await applyPendingMigrations(database.connectionString);

      const rows = await sql<{ conname: string; definition: string }[]>`
        SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE n.nspname = 'public'
          AND t.relname = 'agent_ownership_grants'
          AND c.conname IN (
            'agent_ownership_grants_principal_type_check',
            'agent_ownership_grants_role_check',
            'agent_ownership_grants_source_check'
          )
      `;

      const byName = new Map(rows.map((row) => [row.conname, row.definition]));
      expect(byName.size).toBe(3);

      const principalTypeDef = byName.get("agent_ownership_grants_principal_type_check");
      const roleDef = byName.get("agent_ownership_grants_role_check");
      const sourceDef = byName.get("agent_ownership_grants_source_check");
      expect(principalTypeDef).toBeDefined();
      expect(roleDef).toBeDefined();
      expect(sourceDef).toBeDefined();

      expect(extractAllowedValues(principalTypeDef as string).sort()).toEqual(
        [...AGENT_OWNERSHIP_PRINCIPAL_TYPES].sort(),
      );
      expect(extractAllowedValues(roleDef as string).sort()).toEqual([...AGENT_OWNERSHIP_ROLES].sort());
      expect(extractAllowedValues(sourceDef as string).sort()).toEqual([...AGENT_OWNERSHIP_SOURCES].sort());
    },
    // Starts an embedded Postgres and applies every migration (a cold
    // migration run), which exceeds vitest's 5000ms default under any load.
    // Matches the 30_000ms convention used by the other full-migration-chain
    // embedded-Postgres tests in this package (decision-queue-migrations.test.ts,
    // inbox-archive-agent-policies-migration.test.ts).
    30_000,
  );
});
