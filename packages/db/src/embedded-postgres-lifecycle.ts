const EMBEDDED_POSTGRES_EXIT_EVENTS = [
  "exit",
  "beforeExit",
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
  "SIGBREAK",
  "message",
] as const;

type EmbeddedPostgresExitTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * embedded-postgres installs async-exit-hook listeners as an import side effect.
 * Paperclip-managed clusters have an explicit owner and shutdown path, so those
 * global listeners must not be allowed to stop a cluster independently of that
 * owner (for example while a worktree seed restore is still streaming).
 *
 * Remove only listeners added by the supplied import and preserve every listener
 * that was already registered by Paperclip or its host process.
 */
export async function loadWithoutEmbeddedPostgresExitHooks<T>(
  load: () => Promise<T>,
  target: EmbeddedPostgresExitTarget = process,
): Promise<T> {
  const listenersBeforeLoad = new Map(
    EMBEDDED_POSTGRES_EXIT_EVENTS.map((eventName) => [
      eventName,
      target.rawListeners(eventName),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const eventName of EMBEDDED_POSTGRES_EXIT_EVENTS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(eventName) ?? [])];
      for (const listener of target.rawListeners(eventName)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        target.removeListener(eventName, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

/**
 * The postmaster child spawned by `EmbeddedPostgres.start()`. The module types
 * it as private, but every lifecycle decision below depends on it: whether it
 * has already exited decides whether `stop()` can ever return.
 */
export type EmbeddedPostgresChildProcess = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export type EmbeddedPostgresLifecycle = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Set by `start()` once the postmaster is spawned; `stop()` clears it. */
  process?: EmbeddedPostgresChildProcess;
};

/**
 * How long `start()` may wait for the postmaster to announce readiness.
 *
 * `EmbeddedPostgres.start()` resolves only when the postmaster writes
 * "database system is ready to accept connections" to stderr and rejects only
 * when the child closes. A postmaster that is alive but never says the line --
 * a hot standby (which announces read-only readiness instead), a cluster stuck
 * in recovery, or one whose stderr is routed elsewhere -- leaves that promise
 * pending forever, with nothing logged. 60s matches `pg_ctl start -w` and the
 * readiness budget used after adoption, which also has to cover WAL replay.
 */
export const DEFAULT_EMBEDDED_POSTGRES_START_TIMEOUT_MS = 60_000;

/**
 * How long `stop()` may wait for the postmaster to exit after it is signalled.
 * A live postmaster normally goes within a second or two; anything beyond this
 * means the signal did not land (Windows `taskkill` access denied, for example)
 * and waiting longer only hides that.
 */
export const DEFAULT_EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 15_000;

/** Cadence of `onWaiting` callbacks while a start is still pending. */
export const DEFAULT_EMBEDDED_POSTGRES_START_PROGRESS_INTERVAL_MS = 10_000;

export class EmbeddedPostgresStartTimeoutError extends Error {
  readonly pid: number | null;
  readonly timeoutMs: number;

  constructor(input: { pid: number | null; timeoutMs: number; describe?: string }) {
    super(
      `Embedded PostgreSQL${input.describe ? ` ${input.describe}` : ""} did not report ` +
        `"ready to accept connections" within ${input.timeoutMs}ms` +
        `${input.pid === null ? " (the postmaster was never spawned)" : ` (postmaster pid=${input.pid})`}.`,
    );
    this.name = "EmbeddedPostgresStartTimeoutError";
    this.pid = input.pid;
    this.timeoutMs = input.timeoutMs;
  }
}

export class EmbeddedPostgresStopTimeoutError extends Error {
  readonly pid: number | null;
  readonly timeoutMs: number;

  constructor(input: { pid: number | null; timeoutMs: number; describe?: string }) {
    super(
      `Embedded PostgreSQL${input.describe ? ` ${input.describe}` : ""} did not exit within ` +
        `${input.timeoutMs}ms of being told to stop` +
        `${input.pid === null ? "" : ` (postmaster pid=${input.pid})`}; it may still be running.`,
    );
    this.name = "EmbeddedPostgresStopTimeoutError";
    this.pid = input.pid;
    this.timeoutMs = input.timeoutMs;
  }
}

export function hasEmbeddedPostgresProcessExited(
  child: EmbeddedPostgresChildProcess | undefined,
): boolean {
  if (!child) return false;
  return child.exitCode !== null || child.signalCode !== null;
}

function raceWithDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
  });
  return Promise.race([pending, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type StopEmbeddedPostgresOptions = {
  timeoutMs?: number;
  /** Context for the timeout message, e.g. `on port 54329`. */
  describe?: string;
};

export type StopEmbeddedPostgresOutcome = "stopped" | "already-exited" | "not-started";

/**
 * Stop a postmaster started by `EmbeddedPostgres.start()` without ever waiting
 * forever.
 *
 * `EmbeddedPostgres.stop()` signals the child (SIGINT, or `taskkill` on
 * Windows) and then waits for its `exit` event. If the postmaster already
 * exited -- an operator's force-kill, another process's supervisor, or
 * PostgreSQL shutting itself down after its lock file was removed -- that event
 * fired long ago and the wait never ends. The same pending wait is re-entered
 * by the module's exit hook, so the process cannot even leave cleanly. Detect
 * that case up front and clear the handle exactly as `stop()` itself does after
 * a successful kill; otherwise bound the wait.
 */
export async function stopEmbeddedPostgresWithin(
  instance: EmbeddedPostgresLifecycle,
  options: StopEmbeddedPostgresOptions = {},
): Promise<StopEmbeddedPostgresOutcome> {
  const child = instance.process;
  if (!child) return "not-started";
  if (hasEmbeddedPostgresProcessExited(child)) {
    instance.process = undefined;
    return "already-exited";
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDED_POSTGRES_STOP_TIMEOUT_MS;
  const stopping = instance.stop();
  try {
    await raceWithDeadline(
      stopping,
      timeoutMs,
      () =>
        new EmbeddedPostgresStopTimeoutError({
          pid: child.pid ?? null,
          timeoutMs,
          describe: options.describe,
        }),
    );
    return "stopped";
  } catch (error) {
    if (error instanceof EmbeddedPostgresStopTimeoutError) {
      // The abandoned stop() may still settle later; never let that surface as
      // an unhandled rejection on top of the timeout we are reporting.
      stopping.catch(() => {});
    }
    throw error;
  }
}

export type StartEmbeddedPostgresOptions = {
  timeoutMs?: number;
  stopTimeoutMs?: number;
  progressIntervalMs?: number;
  /** Context for errors and progress, e.g. `on port 54329 (dataDir=...)`. */
  describe?: string;
  /** Called every `progressIntervalMs` while the postmaster has not reported readiness. */
  onWaiting?: (info: { elapsedMs: number; pid: number | null }) => void;
};

/**
 * Start a postmaster and insist that it announce readiness within a budget.
 *
 * On timeout the half-started postmaster is stopped (itself bounded) so the
 * caller is not left with an orphan holding the port and the data directory,
 * and an `EmbeddedPostgresStartTimeoutError` is thrown. Callers that buffer the
 * postmaster's stderr should attach those lines to the error, since they are
 * the only evidence of what the cluster was doing.
 */
export async function startEmbeddedPostgresWithin(
  instance: EmbeddedPostgresLifecycle,
  options: StartEmbeddedPostgresOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDED_POSTGRES_START_TIMEOUT_MS;
  const progressIntervalMs =
    options.progressIntervalMs ?? DEFAULT_EMBEDDED_POSTGRES_START_PROGRESS_INTERVAL_MS;
  const startedAt = Date.now();

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  if (options.onWaiting) {
    const onWaiting = options.onWaiting;
    progressTimer = setInterval(() => {
      onWaiting({ elapsedMs: Date.now() - startedAt, pid: instance.process?.pid ?? null });
    }, progressIntervalMs);
  }

  const starting = instance.start();
  try {
    await raceWithDeadline(
      starting,
      timeoutMs,
      () =>
        new EmbeddedPostgresStartTimeoutError({
          pid: instance.process?.pid ?? null,
          timeoutMs,
          describe: options.describe,
        }),
    );
  } catch (error) {
    if (error instanceof EmbeddedPostgresStartTimeoutError) {
      starting.catch(() => {});
      try {
        await stopEmbeddedPostgresWithin(instance, {
          timeoutMs: options.stopTimeoutMs,
          describe: options.describe,
        });
      } catch {
        // The start timeout is the error worth reporting; a postmaster that
        // also refuses to stop is named by pid in that message.
      }
    }
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}
