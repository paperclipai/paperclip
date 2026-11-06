import { appendFileSync } from "node:fs";

export interface TimelineEntry { at: string; t: number; kind: string; [key: string]: unknown }

/** Append-only action timeline. Every supervisor and launcher action lands here. */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  constructor(private readonly path: string | null, readonly origin = Date.now()) {}

  add(kind: string, data: Record<string, unknown> = {}): TimelineEntry {
    const now = Date.now();
    const entry: TimelineEntry = { ...data, at: new Date(now).toISOString(), t: now - this.origin, kind };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (process.env.RESTART_CHAOS_QUIET !== "1") console.info(`[chaos +${Math.round(entry.t / 1000)}s] ${kind} ${JSON.stringify(data)}`);
    return entry;
  }
}
