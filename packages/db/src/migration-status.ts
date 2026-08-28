import { inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const jsonMode = process.argv.includes("--json");

/**
 * Upper bound for the whole check. Every wait inside resolveMigrationConnection
 * carries its own budget (identify 3s, adoption/readiness 60s, start 60s, stop
 * 15s), so this only has to catch a stall those budgets cannot see -- a query
 * blocked behind a lock, for example. It must exceed their sum so that when one
 * of them fails, its specific error is what gets reported, not this one.
 */
const DEFAULT_WATCHDOG_TIMEOUT_MS = 240_000;

function resolveWatchdogTimeoutMs(): number {
  const raw = process.env.PAPERCLIP_MIGRATION_STATUS_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_WATCHDOG_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WATCHDOG_TIMEOUT_MS;
}

function toError(error: unknown, context = "Migration status check failed"): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

const startedAt = Date.now();
let lastProgress: string | null = null;

function reportProgress(message: string): void {
  lastProgress = message;
  process.stderr.write(`[migration-status +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

/**
 * This process usually runs as a child whose stdio is captured (see
 * scripts/dev-runner.ts), so a stall here shows up to the operator as nothing
 * at all. Exit with a diagnosis instead of waiting indefinitely. The timer is
 * unref'd so it never keeps a finished check alive.
 */
function installWatchdog(): () => void {
  const timeoutMs = resolveWatchdogTimeoutMs();
  const timer = setTimeout(() => {
    process.stderr.write(
      `Migration status check did not finish within ${timeoutMs}ms ` +
        `(last progress: ${lastProgress ?? "none recorded"}). Aborting so the caller can report it; ` +
        `set PAPERCLIP_MIGRATION_STATUS_TIMEOUT_MS to change this budget.\n`,
    );
    process.exit(1);
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

async function main(): Promise<void> {
  const clearWatchdog = installWatchdog();
  const connection = await resolveMigrationConnection({ onProgress: reportProgress });

  try {
    const state = await inspectMigrations(connection.connectionString);
    const payload =
      state.status === "upToDate"
        ? {
            source: connection.source,
            status: "upToDate" as const,
            tableCount: state.tableCount,
            pendingMigrations: [] as string[],
          }
        : {
            source: connection.source,
            status: "needsMigrations" as const,
            tableCount: state.tableCount,
            pendingMigrations: state.pendingMigrations,
            reason: state.reason,
          };

    if (jsonMode) {
      console.log(JSON.stringify(payload));
      return;
    }

    if (payload.status === "upToDate") {
      console.log(`Database is up to date via ${payload.source}`);
      return;
    }

    console.log(
      `Pending migrations via ${payload.source}: ${payload.pendingMigrations.join(", ")}`,
    );
  } finally {
    reportProgress(`stopping ${connection.source}`);
    await connection.stop();
    clearWatchdog();
  }
}

main().catch((error) => {
  const err = toError(error, "Migration status check failed");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
