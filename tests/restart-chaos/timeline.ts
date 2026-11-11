import { appendFileSync } from "node:fs";

export interface TimelineEntry { at: string; t: number; kind: string; [key: string]: unknown }

/**
 * Console echo stops for good once stdout fails (for example EPIPE after the
 * parent that read our output exited). Otherwise every echo raises another
 * error, the uncaught-exception handler records it with another echo, and the
 * timeline grows without bound.
 */
let echoBroken = false;
let echoBrokenBy: string | null = null;
function markEchoBroken(error: unknown) {
  if (echoBroken) return;
  echoBroken = true;
  echoBrokenBy = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`.trim() : String(error);
}
process.stdout.on("error", markEchoBroken);

export function isBrokenStdoutError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/** Append-only action timeline. Every supervisor and launcher action lands here. */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  private stdoutLossRecorded = false;
  constructor(private readonly path: string | null, readonly origin = Date.now()) {}

  private record(kind: string, data: Record<string, unknown>): TimelineEntry {
    const now = Date.now();
    const entry: TimelineEntry = { ...data, at: new Date(now).toISOString(), t: now - this.origin, kind };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  add(kind: string, data: Record<string, unknown> = {}): TimelineEntry {
    const entry = this.record(kind, data);
    if (process.env.RESTART_CHAOS_QUIET !== "1" && !echoBroken && process.stdout.writable) {
      try { console.info(`[chaos +${Math.round(entry.t / 1000)}s] ${kind} ${JSON.stringify(data)}`); }
      catch (error) { if (isBrokenStdoutError(error)) markEchoBroken(error); else throw error; }
    }
    // Say once, in the file only, why the console went quiet.
    if (echoBroken && !this.stdoutLossRecorded) {
      this.stdoutLossRecorded = true;
      this.record("harness_stdout_lost", { error: echoBrokenBy });
    }
    return entry;
  }
}

/** For a broken-stdout error that surfaced elsewhere (for example as an uncaught exception). */
export function markTimelineEchoBroken(error: unknown): void { markEchoBroken(error); }

/** Test hook: whether console echo has been disabled by a broken stdout. */
export function timelineEchoBroken(): boolean { return echoBroken; }
