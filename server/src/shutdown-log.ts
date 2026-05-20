/**
 * Synchronous shutdown breadcrumb.
 *
 * The SIGTERM handler in {@link ./index.ts} uses pino for everything else,
 * but pino runs an async transport — on `process.exit(0)` the queued log
 * lines can race libuv and be dropped before they reach kubelet. That race
 * was observed in production after BLO-4137 (PR #90): the drain code is
 * correct per its unit + integration tests, but the handler's own
 * `logger.info("Shutdown signal received…")` line stopped appearing in
 * `kubectl logs --previous`, leaving us unable to confirm from kubectl
 * alone that the handler was even invoked.
 *
 * This module writes a single line to `process.stderr` synchronously. On
 * Linux, when stderr is piped (the case under kubelet), Node's libuv
 * issues the write `synchronously` before returning to JS, so the line is
 * always visible in kubectl logs regardless of what pino does afterwards.
 *
 * Pair with the existing `logger.info(...)` call in the SIGTERM handler;
 * this is the "did we even get here" breadcrumb, not a replacement for
 * structured logging.
 */
export function logShutdownSignal(signal: NodeJS.Signals): void {
  process.stderr.write(
    `[shutdown] ${signal} received — entering graceful drain\n`,
  );
}
