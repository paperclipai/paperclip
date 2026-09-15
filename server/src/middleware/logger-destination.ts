import type { DestinationStream } from "pino";

/**
 * Keeps a pino transport from taking the server down with it.
 *
 * `pino.transport()` runs pino-pretty on a worker thread (thread-stream). If
 * that worker dies — a full disk, an OOM kill, a crash inside pino-pretty —
 * every later write does this (thread-stream@4.2.0/index.js:262, :466):
 *
 *   write (data) {
 *     if (this[kImpl].destroyed) {
 *       error(this, new Error('the worker has exited'))   // setImmediate(() => emit('error'))
 *
 * An "error" event with no listener is a fatal uncaught exception in Node, so
 * a failure to write a log line becomes a process kill. That is exactly how
 * the server died on 2026-09-14, out of a scheduler's info() call, once the
 * disk filled up.
 *
 * Logging is observability, never a dependency of correctness: if it breaks,
 * the server must keep serving. So we listen for the failure, say so once on
 * the raw fallback, and route subsequent lines there instead.
 */

/** The minimum of a writable we need; keeps `process.stdout` and test doubles interchangeable. */
export interface FallbackStream {
  write(chunk: string): unknown;
}

interface ErrorEmitter {
  on?(event: "error", listener: (err: unknown) => void): unknown;
}

export interface ResilientDestinationOptions {
  /**
   * Announces the one-time transition to degraded logging. It must NOT go
   * through pino: that would re-enter the dead stream and loop forever.
   */
  report?: (message: string) => void;
}

function defaultReport(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Whatever killed the worker (a full disk) can kill stderr too. There is
    // genuinely nothing left to report through, and crashing here would
    // reintroduce the very bug this module exists to fix.
  }
}

export function createResilientDestination(
  primary: DestinationStream & ErrorEmitter,
  fallback: FallbackStream = process.stdout,
  options: ResilientDestinationOptions = {},
): DestinationStream {
  const report = options.report ?? defaultReport;
  let degraded = false;

  const degrade = (err: unknown): void => {
    if (degraded) return; // Report once: a dead logger must not become its own log flood.
    degraded = true;
    const detail = err instanceof Error ? err.message : String(err);
    report(
      `[logger] pretty-print transport failed (${detail}); falling back to plain stdout. ` +
        `Log formatting is degraded but the server is unaffected.`,
    );
  };

  // A bare `{ write }` object is a valid pino DestinationStream, so `.on` is
  // not guaranteed. Where it exists it is the only way to catch thread-stream's
  // asynchronous failure; where it does not, the synchronous guard below is
  // already sufficient, because a non-emitter has no async channel to fail on.
  if (typeof primary.on === "function") {
    primary.on("error", degrade);
  }

  const writeToFallback = (chunk: string): void => {
    try {
      fallback.write(chunk);
    } catch {
      // Both destinations are gone. Drop the line rather than throw.
    }
  };

  return {
    write(chunk: string): void {
      if (!degraded) {
        try {
          primary.write(chunk);
          return;
        } catch (err) {
          // thread-stream reports asynchronously, but a different transport
          // (or a future version) may throw synchronously instead.
          degrade(err);
        }
      }
      writeToFallback(chunk);
    },
  };
}
