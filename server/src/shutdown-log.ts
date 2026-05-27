/**
 * Synchronous shutdown breadcrumbs.
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
 * This module writes lines to `process.stderr` synchronously. On Linux,
 * when stderr is piped (the case under kubelet), Node's libuv issues the
 * write `synchronously` before returning to JS, so the line is always
 * visible in kubectl logs regardless of what pino does afterwards.
 *
 * Pair with the existing `logger.info(...)` calls in the SIGTERM handler;
 * these are the "did we even get here" breadcrumbs, not a replacement for
 * structured logging.
 */

/**
 * Writes a single `[shutdown] <line>\n` breadcrumb to stderr synchronously.
 *
 * The `[shutdown]` prefix matches the existing `logShutdownSignal` line so
 * a single `kubectl logs … | grep '^\[shutdown\]'` recipe lists every
 * synchronous shutdown breadcrumb the handler emitted.
 */
export function writeShutdownBreadcrumb(line: string): void {
  process.stderr.write(`[shutdown] ${line}\n`);
}

/**
 * "Did we even enter the handler?" — the first breadcrumb the SIGTERM/SIGINT
 * handler writes. Kept as a named helper so callers don't have to assemble
 * the canonical line shape; tests + the BLO-4137 grep recipe pin the
 * format.
 */
export function logShutdownSignal(signal: NodeJS.Signals): void {
  writeShutdownBreadcrumb(`${signal} received — entering graceful drain`);
}
