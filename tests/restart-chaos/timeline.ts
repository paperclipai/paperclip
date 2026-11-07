import { appendFileSync } from "node:fs";

export interface TimelineEntry { at: string; t: number; kind: string; [key: string]: unknown }

/**
 * Console echo stops for good once stdout fails (for example EPIPE after the
 * parent that read our output exited). Otherwise every echo raises another
 * error, the uncaught-exception handler records it with another echo, and the
 * timeline grows without bound.
 */
let echoBroken = false;
process.stdout.on("error", () => { echoBroken = true; });

export function isBrokenStdoutError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/** Append-only action timeline. Every supervisor and launcher action lands here. */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  constructor(private readonly path: string | null, readonly origin = Date.now()) {}

  add(kind: string, data: Record<string, unknown> = {}): TimelineEntry {
    const now = Date.now();
    const entry: TimelineEntry = { ...data, at: new Date(now).toISOString(), t: now - this.origin, kind };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (process.env.RESTART_CHAOS_QUIET !== "1" && !echoBroken && process.stdout.writable) {
      try { console.info(`[chaos +${Math.round(entry.t / 1000)}s] ${kind} ${JSON.stringify(data)}`); }
      catch (error) { if (isBrokenStdoutError(error)) echoBroken = true; else throw error; }
    }
    return entry;
  }
}

/** Test hook: whether console echo has been disabled by a broken stdout. */
export function timelineEchoBroken(): boolean { return echoBroken; }
