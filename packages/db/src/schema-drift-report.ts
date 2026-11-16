import { formatSchemaDriftReport, inspectSchemaDrift } from "./schema-drift.js";
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

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection();

  try {
    const report = await inspectSchemaDrift(connection.connectionString);

    if (jsonMode) {
      console.log(JSON.stringify({ source: connection.source, ...report }));
    } else if (report.drifted) {
      console.log(`Drift via ${connection.source}:`);
      console.log(formatSchemaDriftReport(report));
    } else {
      console.log(`${formatSchemaDriftReport(report)} via ${connection.source}`);
    }

    // Non-zero exit so this doubles as a CI/CD deploy gate.
    if (report.drifted) process.exitCode = 1;
  } finally {
    await connection.stop();
  }
}

main().catch((error) => {
  const err = toError(error);
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
