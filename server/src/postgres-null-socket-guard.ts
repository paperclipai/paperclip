// Process-level guard for a known defect in the `postgres` driver: when a
// database backend closes a connection that a transaction still holds, the
// driver's own reconnect bookkeeping still lets a later query on that same
// connection object proceed. That query defers its wire write to a timer
// callback. By the time the callback runs, the driver has already set its
// socket reference to null, and the write throws a `TypeError`. No
// application `try`/`catch` sits between that timer callback and the
// process, so Node ends the process by default.
//
// This module does not patch the driver and does not change the driver
// version. It adds one `uncaughtException` listener. Registering a listener
// cancels Node's default crash-on-uncaught-exception behavior, so the
// listener must end the process itself for every uncaught exception except
// the one known, neutralized fault below — otherwise an unrelated bug would
// leave the process running in a state nobody chose.
//
// For the known, neutralized fault, this module reports no telemetry event
// and calls no external error-reporting client. It logs one structured
// line, with a fixed marker and the error name only — never a query, a
// query parameter, a connection URL, a host name, or a database name.
//
// Interaction with Sentry: this module is the sole owner of the process's
// `uncaughtException` decision. `sentry.ts` removes the default
// `OnUncaughtException` integration from `Sentry.init`, so an operator who
// installs `@sentry/node` and sets a Sentry DSN gets no second,
// independent `uncaughtException` listener — Node calls every registered
// listener for an event, not just the first one, so a second listener
// would still end the process on the known, neutralized fault regardless
// of listener order. Instead, for every uncaught exception this module
// does not neutralize, it reports the error to Sentry itself (through
// `captureException`) and waits for the client to flush (through
// `shutdownSentry`) before it ends the process — the same sequence
// `index.ts` uses for a startup failure. A deployment with no Sentry DSN
// set sees no change: both calls are no-ops.

import { logger } from "./middleware/logger.js";
import { captureException, shutdownSentry } from "./sentry.js";

const GUARD_ENABLED_ENV_VAR = "POSTGRES_NULL_SOCKET_GUARD_ENABLED";
const GUARD_MARKER = "postgres_null_socket_write_guard_neutralized";

// Both V8 message spellings for a read of a property on `null`. The wording
// changed between an older V8 (`Cannot read property 'write' of null`) and
// a newer V8 (`Cannot read properties of null (reading 'write')`).
const NULL_WRITE_MESSAGE_PATTERN =
  /Cannot read propert(?:y 'write' of null|ies of null \(reading 'write'\))/;

// Matches the frame, not an absolute path, so the check survives any
// install-path prefix (a package-store path, a different path separator).
const NEXT_WRITE_FRAME_PATTERN = /\bnextWrite\b.*postgres[\\/]src[\\/]connection\.js/;

/**
 * Matches the known driver defect: a `TypeError` from a deferred write to a
 * socket the driver already set to null, after a database backend closed
 * the connection. Matches three facts together — the error class, both V8
 * message spellings, and a `nextWrite` frame in the driver's connection
 * module — so an unrelated `TypeError` never counts.
 */
export function isPostgresNullSocketWriteCrash(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TypeError") return false;
  if (!NULL_WRITE_MESSAGE_PATTERN.test(error.message)) return false;
  const stack = error.stack ?? "";
  return stack.split("\n").some((line) => NEXT_WRITE_FRAME_PATTERN.test(line));
}

/**
 * Reads the runtime opt-out. An operator sets `false` or `0` to disable the
 * guard; every other value, including an unset variable, keeps it enabled.
 * Follows the same boolean convention as `envBoolean` in
 * `packages/db/src/client.ts`: a value other than a recognized true/false
 * spelling is a configuration mistake, so this throws instead of guessing.
 */
export function isGuardEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[GUARD_ENABLED_ENV_VAR]?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${GUARD_ENABLED_ENV_VAR} must be "true" or "false", got: ${env[GUARD_ENABLED_ENV_VAR]}`);
}

/**
 * Handles one uncaught exception. The known driver fault logs one
 * structured, searchable line and returns — the process survives, and
 * Sentry hears nothing about it. Every other error keeps today's default
 * behavior: log, report to Sentry, then end the process. Exported so a
 * test can drive it directly instead of dispatching a real process event.
 */
export async function handlePostgresNullSocketGuardException(error: unknown): Promise<void> {
  if (isPostgresNullSocketWriteCrash(error)) {
    logger.error(
      { marker: GUARD_MARKER, errorName: (error as Error).name },
      "neutralized a known postgres driver crash: a deferred write reached a connection socket the driver had already closed",
    );
    return;
  }

  const rootError = error instanceof Error ? error : new Error(String(error));
  logger.fatal({ err: rootError }, "uncaught exception; process exiting");
  captureException(rootError);
  await shutdownSentry();
  process.exit(1);
}

/**
 * Registers the guard's `uncaughtException` listener, unless an operator
 * disables it with `POSTGRES_NULL_SOCKET_GUARD_ENABLED=false` (or `0`).
 * Call this once, early, from the server entry point. This function is
 * idempotent: a repeat call adds no second listener, so a caller that runs
 * many times in one process (a test suite that calls `startServer()`
 * repeatedly) never exceeds Node's default listener-count warning.
 */
export function registerPostgresNullSocketGuard(env: NodeJS.ProcessEnv = process.env): void {
  if (!isGuardEnabled(env)) return;
  if (process.listeners("uncaughtException").includes(handlePostgresNullSocketGuardException)) return;
  process.on("uncaughtException", handlePostgresNullSocketGuardException);
}
