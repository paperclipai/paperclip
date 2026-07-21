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
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | string | null;
}

export type RuntimeStatusSink = (update: RuntimeStatusUpdate) => void | Promise<void>;

/**
 * Which transport carried a sync artifact's bytes. Phase 0 (PAP-2952) always
 * records the base64-shell `"fallback"`; later phases populate `"native"` once
 * the sandbox seam gains a direct upload verb. Placeholder tag on the timer line
 * so Phase 6 can compare fallback-vs-native durations from the same log shape.
 */
export type SandboxSyncTransport = "native" | "fallback";

export interface SyncStageTimerOptions {
  /** Where the aggregated duration line is written (the run log). Undefined = disabled. */
  sink: RuntimeProgressSink | undefined;
  /** Reused status-phase label, e.g. "git_sync" / "config_sync". */
  phase: RuntimeStatusPhase;
  /** Per-artifact label, e.g. "git history", "workspace", or an asset key. */
  artifact: string;
  /** Transport tag placeholder; defaults to "fallback" (see {@link SandboxSyncTransport}). */
  transport?: SandboxSyncTransport;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

export interface SyncStageTimer {
  /**
   * Run `fn`, recording its wall-clock duration under `stage`. Returns `fn`'s
   * result and re-throws its error; the duration is recorded either way so a
   * failing stage still contributes to the breakdown.
   */
  time<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Emit the aggregated per-stage + total duration line for this artifact.
   * Idempotent; a no-op when no sink was provided or no stage was timed.
   */
  finish(): Promise<void>;
}

/**
 * Duration instrumentation for a single sync artifact's tar → upload → extract
 * seams. Each stage is wrapped with `time()`; `finish()` emits one legible line
 * carrying the per-stage durations, the total, and the transport tag — the
 * measurement baseline Phase 6 compares before/after.
 */
export function createSyncStageTimer(options: SyncStageTimerOptions): SyncStageTimer {
  const now = options.now ?? Date.now;
  const transport: SandboxSyncTransport = options.transport ?? "fallback";
  const stages: { stage: string; durationMs: number }[] = [];
  let finished = false;

  return {
    async time(stage, fn) {
      const startedAt = now();
      try {
        return await fn();
      } finally {
        stages.push({ stage, durationMs: Math.max(0, Math.round(now() - startedAt)) });
      }
    },
    async finish() {
      if (finished) return;
      finished = true;
      if (!options.sink || stages.length === 0) return;
      const totalMs = stages.reduce((sum, entry) => sum + entry.durationMs, 0);
      const breakdown = stages.map((entry) => `${entry.stage} ${entry.durationMs}ms`).join(", ");
      try {
        await options.sink(
          `[paperclip] sync ${options.phase} ${options.artifact}: ${breakdown} (total ${totalMs}ms) [transport=${transport}]\n`,
        );
      } catch {
        // Sink errors must not propagate — duration logging is observability-only.
      }
    },
  };
}

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
