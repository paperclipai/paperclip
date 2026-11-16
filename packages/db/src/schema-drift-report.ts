import { formatSchemaDriftReport, inspectSchemaDrift, type SchemaDriftReport } from "./schema-drift.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const jsonMode = process.argv.includes("--json");

function toError(error: unknown, context = "Schema drift check failed"): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);
  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

type DriftTarget = { source: string; connectionString: string };

async function reportTarget(target: DriftTarget): Promise<SchemaDriftReport> {
  const report = await inspectSchemaDrift(target.connectionString);
  if (jsonMode) {
    console.log(JSON.stringify({ source: target.source, ...report }));
  } else if (report.drifted) {
    console.log(`Drift via ${target.source}:`);
    console.log(formatSchemaDriftReport(report));
  } else {
    console.log(`${formatSchemaDriftReport(report)} via ${target.source}`);
  }
  return report;
}

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection();

  try {
    const targets: DriftTarget[] = [
      { source: connection.source, connectionString: connection.connectionString },
    ];
    const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim();
    if (migrationUrl && migrationUrl !== connection.connectionString) {
      targets.push({ source: "DATABASE_MIGRATION_URL", connectionString: migrationUrl });
    }

    let drifted = false;
    for (const target of targets) {
      const report = await reportTarget(target);
      drifted = drifted || report.drifted;
    }

    if (drifted) process.exitCode = 1;
  } finally {
    await connection.stop();
  }
}

main().catch((error) => {
  const err = toError(error);
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
