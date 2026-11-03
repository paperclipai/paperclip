/**
 * Run the stale-run evaluation close-out rule over the existing backlog.
 *
 * TON-927: the watchdog used to raise a `stale_active_run_evaluation` card for every long
 * file-backed run, and every one of those cards had to be hand-closed by a human with the
 * same answer ("false positive - the run was producing output"). The close-out rule in
 * `server/src/services/recovery/stale-run-evaluation-closeout.ts` retires those cards
 * automatically once their origin run is terminal.
 *
 * The rule also runs on the server's periodic watchdog tick, so this script is for the
 * one-off case: sweeping a backlog that predates the rule, or re-running it after a fix.
 *
 * Usage:
 *   pnpm exec tsx scripts/close-stale-run-evaluations.ts [--company <companyId>] [--dry-run]
 *                                                                   [--database-url <url>]
 */

import { companies, createDb } from "../packages/db/src/index.js";
import { readConfigFile } from "../server/src/config-file.js";
import { recoveryService } from "../server/src/services/recovery/service.ts";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

/**
 * Resolve the database the running instance uses.
 *
 * Deliberately NOT `loadConfig()`: that helper loads the repo's `.env` into the environment,
 * and this repo's `.env` carries a `DATABASE_URL` pointing at a *different* Postgres than the
 * instance actually runs on. The server never sees it because its systemd unit runs from the
 * instance home; a script run from the repo root would inherit it and write to the wrong
 * database. So the instance config file is read directly here, and `DATABASE_URL` is honoured
 * only when it is passed explicitly with `--database-url`.
 */
function resolveDatabaseUrl(explicitUrl: string | null): string {
  if (explicitUrl) return explicitUrl;

  const fileConfig = readConfigFile();
  const mode = fileConfig?.database?.mode === "postgres" ? "postgres" : "embedded-postgres";
  if (mode === "postgres") {
    const connectionString = fileConfig?.database?.connectionString?.trim();
    if (!connectionString) {
      throw new Error(
        "The instance is configured for external PostgreSQL but has no connection string. Pass --database-url.",
      );
    }
    return connectionString;
  }

  const port = fileConfig?.database?.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function main() {
  const dbUrl = resolveDatabaseUrl(parseFlag("--database-url"));
  const companyId = parseFlag("--company");
  const dryRun = process.argv.includes("--dry-run");

  const db = createDb(dbUrl);
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to close.");
    return;
  }

  const recovery = recoveryService(db, { enqueueWakeup: async () => null });

  console.log(
    `Running the stale-run evaluation close-out rule over ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}${dryRun ? " (dry run)" : ""}...`,
  );

  let totalScanned = 0;
  let totalClosed = 0;
  for (const company of companyRows) {
    const result = await recovery.autoCloseTerminalStaleRunEvaluations({
      companyId: company.id,
      dryRun,
    });
    totalScanned += result.scanned;
    totalClosed += result.closed;
    console.log(
      `- ${company.id}: scanned ${result.scanned}, ${dryRun ? "would close" : "closed"} ${result.closed}` +
        (result.closedIdentifiers.length > 0
          ? ` (${result.closedIdentifiers.join(", ")})`
          : ""),
    );
  }

  console.log(
    dryRun
      ? `Dry run complete: ${totalScanned} stale-run evaluation card(s) examined, ${totalClosed} would be closed.`
      : `Close-out complete: ${totalScanned} stale-run evaluation card(s) examined, ${totalClosed} closed.`,
  );
}

void main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Stale-run evaluation close-out failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The postgres pool holds the event loop open; without this the CLI hangs after the work
    // is done instead of exiting.
    process.exit(process.exitCode ?? 0);
  });
