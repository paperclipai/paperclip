// Shared, throttled progress reporting for execution-target sync/restore.
//
// Transports (sandbox / SSH) own the byte counting and call `report()` as bytes
// move; orchestrators own the per-phase label and direction. The reporter
// throttles emits so a long transfer doesn't flood the log: a line is emitted
// only when the percentage crosses a step boundary (default every 10%) or once
// at least `minIntervalMs` has elapsed since the last emit. The terminal
// completion line is always emitted via `complete()` (or when `report()` reaches
// the known total).

/** A sink for fully-formatted progress lines (newline included). */
export type RuntimeProgressSink = (line: string) => void | Promise<void>;

export type RuntimeProgressPhase =
  | "Syncing"
  | "Restoring"
  | "Importing git history"
  | "Exporting git history";

export type RuntimeProgressDirection = "to" | "from";

export type RuntimeProgressTarget = "sandbox" | "ssh";

export type RuntimeStatusPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize";

export interface RuntimeStatusUpdate {
  phase: RuntimeStatusPhase;
  message: string;
}

export type RuntimeStatusSink = (update: RuntimeStatusUpdate) => void | Promise<void>;

export interface RuntimeProgressReporterOptions {
  sink: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  /** Optional per-phase label, e.g. "workspace" or an asset key. */
  label?: string;
  direction: RuntimeProgressDirection;
  target: RuntimeProgressTarget;
  /** Emit when the percentage crosses this step. Default 10. */
  stepPercent?: number;
  /** Emit when at least this many ms have elapsed since the last emit. Default 2000. */
  minIntervalMs?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

export interface RuntimeProgressReporter {
  /**
   * Report progress. Throttled: only emits on a step crossing or after
   * `minIntervalMs`. When `totalBytes` is known and `doneBytes` reaches it, the
   * terminal 100% line is emitted and the reporter is marked complete.
   */
  report(doneBytes: number, totalBytes: number | null): Promise<void>;
  /**
   * Emit the terminal completion line if it hasn't been emitted yet. Idempotent.
   */
  complete(doneBytes?: number, totalBytes?: number | null): Promise<void>;
  /**
   * Emit a terminal failure line if no terminal line has been emitted yet, so a
   * failed transfer leaves an explicit marker instead of a dangling percentage.
   * Idempotent and mutually exclusive with `complete()`.
   */
  fail(doneBytes?: number, totalBytes?: number | null): Promise<void>;
}

const BYTES_PER_MB = 1024 * 1024;

function formatMb(bytes: number): string {
  return (Math.max(0, bytes) / BYTES_PER_MB).toFixed(1);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function createRuntimeProgressReporter(
  options: RuntimeProgressReporterOptions,
): RuntimeProgressReporter {
  const stepPercent = options.stepPercent && options.stepPercent > 0 ? options.stepPercent : 10;
  const minIntervalMs =
    options.minIntervalMs && options.minIntervalMs > 0 ? options.minIntervalMs : 2000;
  const now = options.now ?? Date.now;
  const prefix = `[paperclip] ${options.phase}${options.label ? ` ${options.label}` : ""} ${options.direction} ${options.target}`;

  let lastEmitAt: number | null = null;
  let lastStep = -1;
  let lastDoneBytes = 0;
  let lastTotalBytes: number | null = null;
  let completed = false;

  function buildLine(doneBytes: number, totalBytes: number | null): string {
    if (totalBytes != null && totalBytes > 0) {
      const pct = clampPercent((doneBytes / totalBytes) * 100);
      return `${prefix}: ${pct}% (${formatMb(doneBytes)}/${formatMb(totalBytes)} MB)\n`;
    }
    return `${prefix}: ${formatMb(doneBytes)} MB\n`;
  }

  function buildFailLine(doneBytes: number, totalBytes: number | null): string {
    if (totalBytes != null && totalBytes > 0) {
      const pct = clampPercent((doneBytes / totalBytes) * 100);
      return `${prefix}: failed at ${pct}% (${formatMb(doneBytes)}/${formatMb(totalBytes)} MB)\n`;
    }
    return `${prefix}: failed after ${formatMb(doneBytes)} MB\n`;
  }

  async function emit(doneBytes: number, totalBytes: number | null): Promise<void> {
    lastEmitAt = now();
    if (totalBytes != null && totalBytes > 0) {
      lastStep = Math.floor(((doneBytes / totalBytes) * 100) / stepPercent);
    }
    await options.sink(buildLine(doneBytes, totalBytes));
  }

  return {
    async report(doneBytes, totalBytes) {
      lastDoneBytes = doneBytes;
      lastTotalBytes = totalBytes;
      if (completed) return;

      const elapsedOk = lastEmitAt == null || now() - lastEmitAt >= minIntervalMs;

      if (totalBytes != null && totalBytes > 0) {
        const terminal = doneBytes >= totalBytes;
        const step = Math.floor(((doneBytes / totalBytes) * 100) / stepPercent);
        const stepOk = step > lastStep;
        if (terminal || stepOk || elapsedOk) {
          await emit(doneBytes, totalBytes);
        }
        if (terminal) completed = true;
        return;
      }

      // Unknown total: no step boundaries, throttle purely on elapsed time.
      if (elapsedOk) {
        await emit(doneBytes, totalBytes);
      }
    },
    async complete(doneBytes, totalBytes) {
      if (completed) return;
      completed = true;
      const total = totalBytes !== undefined ? totalBytes : lastTotalBytes;
      const done =
        doneBytes !== undefined
          ? doneBytes
          : total != null && total > 0
            ? total
            : lastDoneBytes;
      await options.sink(buildLine(done, total));
    },
    async fail(doneBytes, totalBytes) {
      if (completed) return;
      completed = true;
      const total = totalBytes !== undefined ? totalBytes : lastTotalBytes;
      const done = doneBytes !== undefined ? doneBytes : lastDoneBytes;
      await options.sink(buildFailLine(done, total));
    },
  };
}
