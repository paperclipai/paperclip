import {
  assertNoSchemaDrift,
  formatSchemaDriftReport,
  SchemaDriftError,
  type SchemaDriftReport,
} from "@paperclipai/db";

export type SchemaDriftGateTarget = { url: string; label: string };

export type SchemaDriftGateLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (msg: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type SchemaDriftGateOptions = {
  allowDrift: boolean;
  logger: SchemaDriftGateLogger;
  assertNoDrift?: (url: string) => Promise<SchemaDriftReport>;
};

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

export function readSchemaDriftEscapeHatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.PAPERCLIP_ALLOW_SCHEMA_DRIFT === "true" ||
    env.PAPERCLIP_SCHEMA_DRIFT_ALLOW === "true"
  );
}
