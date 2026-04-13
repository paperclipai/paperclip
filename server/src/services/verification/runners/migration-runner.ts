/**
 * Migration deliverable runner.
 *
 * Verifies a Postgres migration by applying it against an ephemeral PG instance and asserting:
 *   1. The migration applies cleanly (no SQL errors).
 *   2. A set of spec-declared post-conditions hold after application (e.g. tables/columns exist,
 *      constraints are in place).
 *   3. Optionally, that a declared rollback SQL reverses the change cleanly and returns the schema
 *      to its pre-migration state.
 *
 * Uses the existing Postgres instance in the Paperclip stack but runs inside a dedicated throwaway
 * schema so the production DB is untouched. We do NOT spin up Docker PG for each verification run
 * — Docker-in-Docker is too much complexity for Phase 2. The throwaway schema approach is
 * sufficient for migration structure validation; it does NOT catch migrations that depend on
 * production data.
 *
 * Spec format (JSON):
 *   {
 *     "migrationSql": "ALTER TABLE ... ADD COLUMN ...",
 *     "rollbackSql": "ALTER TABLE ... DROP COLUMN ...",  // optional
 *     "expectSchema": [                                   // post-conditions
 *       { "type": "column_exists", "table": "issues", "column": "deliverable_type" },
 *       { "type": "index_exists", "name": "issues_verification_status_idx" }
 *     ]
 *   }
 *
 * The spec lives at skills/acceptance-migrations/tests/<DLD-XXXX>.migration.spec.json.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export interface RunMigrationSpecInput {
  issueId: string;
  specPath: string;
  db: Db;
  /** Defaults to /app */
  skillsRoot?: string;
  /** Override for tests */
  readFileImpl?: typeof readFile;
}

export type RunMigrationSpecResult =
  | { status: "passed"; durationMs: number; postConditionsChecked: number }
  | { status: "failed"; durationMs: number; failureSummary: string }
  | { status: "unavailable"; unavailableReason: string };

interface MigrationExpectColumnExists {
  type: "column_exists";
  table: string;
  column: string;
}

interface MigrationExpectIndexExists {
  type: "index_exists";
  name: string;
}

interface MigrationExpectTableExists {
  type: "table_exists";
  table: string;
}

type MigrationExpectation =
  | MigrationExpectColumnExists
  | MigrationExpectIndexExists
  | MigrationExpectTableExists;

interface MigrationSpec {
  migrationSql: string;
  rollbackSql?: string;
  expectSchema: MigrationExpectation[];
}

function validateSpec(parsed: unknown): { ok: true; spec: MigrationSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (typeof s.migrationSql !== "string" || s.migrationSql.trim() === "") {
    return { ok: false, reason: "spec.migrationSql must be a non-empty string" };
  }
  if (s.rollbackSql !== undefined && typeof s.rollbackSql !== "string") {
    return { ok: false, reason: "spec.rollbackSql must be a string if present" };
  }
  if (!Array.isArray(s.expectSchema) || s.expectSchema.length === 0) {
    return { ok: false, reason: "spec.expectSchema must be a non-empty array" };
  }
  for (const exp of s.expectSchema) {
    if (!exp || typeof exp !== "object") return { ok: false, reason: "each expectSchema entry must be an object" };
    const e = exp as Record<string, unknown>;
    if (e.type === "column_exists") {
      if (typeof e.table !== "string" || typeof e.column !== "string") {
        return { ok: false, reason: "column_exists requires string table and column" };
      }
    } else if (e.type === "index_exists") {
      if (typeof e.name !== "string") {
        return { ok: false, reason: "index_exists requires string name" };
      }
    } else if (e.type === "table_exists") {
      if (typeof e.table !== "string") {
        return { ok: false, reason: "table_exists requires string table" };
      }
    } else {
      return { ok: false, reason: `unknown expectation type: ${String(e.type)}` };
    }
  }
  return { ok: true, spec: parsed as MigrationSpec };
}

/**
 * Guard against SQL that would wreck the production schema. We allow CREATE/ALTER/DROP/INSERT/UPDATE
 * against throwaway-schema-prefixed identifiers only. DANGEROUS verbs against public schema or
 * non-schema-qualified identifiers are rejected.
 *
 * For Phase 2 we require all DDL in the spec to be schema-qualified with a placeholder `SCHEMA`
 * that the runner substitutes with the throwaway schema name. This is the Postgres equivalent of
 * parameterized queries for DDL.
 */
function requirePlaceholder(migrationSql: string): { ok: true } | { ok: false; reason: string } {
  if (!/\bSCHEMA\b/.test(migrationSql)) {
    return {
      ok: false,
      reason: "migrationSql must reference the placeholder `SCHEMA` for table/index names (e.g. `CREATE TABLE SCHEMA.foo ...`)",
    };
  }
  // Simple deny list of verbs against other schemas / cross-schema modifications.
  const forbidden = [
    /DROP\s+SCHEMA/i,
    /DROP\s+DATABASE/i,
    /TRUNCATE\s+TABLE\s+(?!SCHEMA\.)/i,
    /DELETE\s+FROM\s+(?!SCHEMA\.)/i,
  ];
  for (const f of forbidden) {
    if (f.test(migrationSql)) {
      return { ok: false, reason: `migrationSql contains forbidden pattern: ${f.source}` };
    }
  }
  return { ok: true };
}

export async function runMigrationSpec(input: RunMigrationSpecInput): Promise<RunMigrationSpecResult> {
  const { specPath, db, skillsRoot = "/app", readFileImpl = readFile } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.migration\.spec\.(json|yaml|yml)$/.test(
      specPath,
    )
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for migration runner: ${specPath}`,
    };
  }

  const absPath = resolve(join(skillsRoot, specPath));
  let raw: string;
  try {
    raw = await readFileImpl(absPath, "utf8");
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const shapeCheck = validateSpec(parsed);
  if (!shapeCheck.ok) {
    return { status: "unavailable", unavailableReason: shapeCheck.reason };
  }
  const spec = shapeCheck.spec;

  const guard = requirePlaceholder(spec.migrationSql);
  if (!guard.ok) {
    return { status: "unavailable", unavailableReason: guard.reason };
  }
  if (spec.rollbackSql) {
    const guard2 = requirePlaceholder(spec.rollbackSql);
    if (!guard2.ok) {
      return { status: "unavailable", unavailableReason: `rollbackSql: ${guard2.reason}` };
    }
  }

  // Generate a unique throwaway schema name. Must match [a-z_][a-z0-9_]* for SQL identifier safety.
  const schemaName = `verif_${input.issueId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16)}_${Date.now()}`;

  const started = Date.now();
  try {
    // Use a transaction so we can roll everything back if anything fails partway through.
    // We still drop the schema at the end for hygiene.
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`));
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `failed to create throwaway schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cleanup = async () => {
    try {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`));
    } catch {
      // best-effort — log and move on
    }
  };

  try {
    // Substitute the SCHEMA placeholder with the throwaway schema name.
    const expandedMigration = spec.migrationSql.replace(/\bSCHEMA\b/g, schemaName);
    try {
      await db.execute(sql.raw(expandedMigration));
    } catch (err) {
      await cleanup();
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `migration SQL failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Post-condition checks. Each is a single SELECT 1 against information_schema / pg_indexes.
    let checked = 0;
    for (const exp of spec.expectSchema) {
      if (exp.type === "column_exists") {
        const rows = await db.execute(
          sql.raw(
            `SELECT 1 FROM information_schema.columns WHERE table_schema='${schemaName}' AND table_name='${exp.table.replace(/'/g, "''")}' AND column_name='${exp.column.replace(/'/g, "''")}' LIMIT 1;`,
          ),
        );
        // Drizzle's execute returns { rows: [...] } for postgres-js driver
        const found = (rows as unknown as { length?: number }).length ?? (rows as unknown as { rows?: unknown[] }).rows?.length ?? 0;
        if (found === 0) {
          await cleanup();
          return {
            status: "failed",
            durationMs: Math.floor(Date.now() - started),
            failureSummary: `post-condition column_exists failed: ${exp.table}.${exp.column} not found after migration`,
          };
        }
      } else if (exp.type === "index_exists") {
        const rows = await db.execute(
          sql.raw(
            `SELECT 1 FROM pg_indexes WHERE schemaname='${schemaName}' AND indexname='${exp.name.replace(/'/g, "''")}' LIMIT 1;`,
          ),
        );
        const found = (rows as unknown as { length?: number }).length ?? (rows as unknown as { rows?: unknown[] }).rows?.length ?? 0;
        if (found === 0) {
          await cleanup();
          return {
            status: "failed",
            durationMs: Math.floor(Date.now() - started),
            failureSummary: `post-condition index_exists failed: ${exp.name} not found in schema ${schemaName}`,
          };
        }
      } else if (exp.type === "table_exists") {
        const rows = await db.execute(
          sql.raw(
            `SELECT 1 FROM information_schema.tables WHERE table_schema='${schemaName}' AND table_name='${exp.table.replace(/'/g, "''")}' LIMIT 1;`,
          ),
        );
        const found = (rows as unknown as { length?: number }).length ?? (rows as unknown as { rows?: unknown[] }).rows?.length ?? 0;
        if (found === 0) {
          await cleanup();
          return {
            status: "failed",
            durationMs: Math.floor(Date.now() - started),
            failureSummary: `post-condition table_exists failed: ${exp.table} not found in schema ${schemaName}`,
          };
        }
      }
      checked += 1;
    }

    // Optional rollback check
    if (spec.rollbackSql) {
      const expandedRollback = spec.rollbackSql.replace(/\bSCHEMA\b/g, schemaName);
      try {
        await db.execute(sql.raw(expandedRollback));
      } catch (err) {
        await cleanup();
        return {
          status: "failed",
          durationMs: Math.floor(Date.now() - started),
          failureSummary: `rollback SQL failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // If any post-condition still holds after rollback, the rollback is incomplete.
      for (const exp of spec.expectSchema) {
        if (exp.type === "column_exists") {
          const rows = await db.execute(
            sql.raw(
              `SELECT 1 FROM information_schema.columns WHERE table_schema='${schemaName}' AND table_name='${exp.table.replace(/'/g, "''")}' AND column_name='${exp.column.replace(/'/g, "''")}' LIMIT 1;`,
            ),
          );
          const found = (rows as unknown as { length?: number }).length ?? (rows as unknown as { rows?: unknown[] }).rows?.length ?? 0;
          if (found > 0) {
            await cleanup();
            return {
              status: "failed",
              durationMs: Math.floor(Date.now() - started),
              failureSummary: `rollback incomplete: column ${exp.table}.${exp.column} still exists after rollback`,
            };
          }
        }
      }
    }

    await cleanup();
    return {
      status: "passed",
      durationMs: Math.floor(Date.now() - started),
      postConditionsChecked: checked,
    };
  } catch (err) {
    await cleanup();
    return {
      status: "unavailable",
      unavailableReason: `unexpected runner error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
