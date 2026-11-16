import {
  assertNoSchemaDrift,
  formatSchemaDriftReport,
  SchemaDriftError,
  type SchemaDriftReport,
} from "@paperclipai/db";

/**
 * Boot/deploy schema-drift gate (AGE-771, part of the AGE-764 deploy gate).
 *
 * The migration journal (`inspectMigrations`) can report "up to date" against a
 * schema that is actually missing columns/tables a recorded migration was
 * supposed to introduce (the AGE-759 drift pattern). This gate independently
 * compares the drizzle schema the application code expects against each live
 * database the process actually uses, and refuses to start on drift so the
 * server never serves traffic against a broken schema. An emergency escape hatch
 * (`PAPERCLIP_ALLOW_SCHEMA_DRIFT` / `PAPERCLIP_SCHEMA_DRIFT_ALLOW`) downgrades the
 * refusal to a warning.
 *
 * Extracted from `startServer` so the refuse-to-start / escape-hatch decision is
 * unit-testable without booting the full HTTP server.
 */

export type SchemaDriftGateTarget = { url: string; label: string };

/** Minimal logger surface the gate needs; satisfied by the pino server logger. */
export type SchemaDriftGateLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (msg: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type SchemaDriftGateOptions = {
  /** When true, drift is logged but startup is allowed to continue (unsafe). */
  allowDrift: boolean;
  logger: SchemaDriftGateLogger;
  /**
   * Drift inspector, injectable for tests. Defaults to the real db-backed
   * `assertNoSchemaDrift`, which throws `SchemaDriftError` on drift.
   */
  assertNoDrift?: (url: string) => Promise<SchemaDriftReport>;
};

/**
 * Verify every target connection against the application's expected schema.
 * Throws (refusing boot) on the first drifted target unless `allowDrift` is set.
 * Non-drift errors (e.g. the database being unreachable) propagate unchanged.
 */
export async function enforceSchemaDriftGate(
  targets: SchemaDriftGateTarget[],
  options: SchemaDriftGateOptions,
): Promise<void> {
  const assertNoDrift = options.assertNoDrift ?? assertNoSchemaDrift;
  for (const target of targets) {
    try {
      const driftReport = await assertNoDrift(target.url);
      options.logger.info(
        { checkedTables: driftReport.checkedTables, target: target.label },
        `Schema-drift gate passed for ${target.label}: live schema matches application schema`,
      );
    } catch (error) {
      if (error instanceof SchemaDriftError) {
        options.logger.error(
          {
            target: target.label,
            missingTables: error.report.missingTables,
            missingColumns: error.report.missingColumns,
            checkedTables: error.report.checkedTables,
          },
          `Schema-drift gate FAILED for ${target.label}: live database is missing schema the application code expects.\n${formatSchemaDriftReport(error.report)}`,
        );
        if (!options.allowDrift) {
          throw new Error(
            `Refusing to start against a drifted schema (${target.label}). Run \`pnpm db:migrate\` to restore ` +
              "the missing tables/columns, confirm DATABASE_URL and DATABASE_MIGRATION_URL point at the same " +
              "database, or set PAPERCLIP_ALLOW_SCHEMA_DRIFT=true to override (unsafe).",
          );
        }
        options.logger.warn(
          `PAPERCLIP_ALLOW_SCHEMA_DRIFT=true set; continuing startup despite schema drift on ${target.label} (unsafe).`,
        );
      } else {
        throw error;
      }
    }
  }
}

/**
 * Read the schema-drift escape hatch from the environment. Accepts the clearer
 * primary name and the `PAPERCLIP_SCHEMA_DRIFT_ALLOW` alias documented on the
 * AGE-771 ticket.
 */
export function readSchemaDriftEscapeHatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.PAPERCLIP_ALLOW_SCHEMA_DRIFT === "true" ||
    env.PAPERCLIP_SCHEMA_DRIFT_ALLOW === "true"
  );
}
