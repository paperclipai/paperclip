import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntryLite {
  ts: string;
  agent?: string;
  targetLlm?: string;
  blocked: boolean;
  blockedReason?: string;
  findings?: Record<string, number>;
}

export interface AuditTailerOptions {
  dir: string;
  /** Optionaler fester Tag (YYYY-MM-DD). Fehlt er, wird immer das aktuelle Datum genutzt. */
  day?: string;
  now?: () => Date;
}

export class AuditTailer {
  private readonly dir: string;
  private readonly fixedDay: string | undefined;
  private readonly now: () => Date;
  private currentDay = "";
  private offset = 0;
  private buffer = "";

  constructor(opts: AuditTailerOptions) {
    this.dir = opts.dir;
    this.fixedDay = opts.day;
    this.now = opts.now ?? (() => new Date());
  }

  private today(): string {
    return this.fixedDay ?? this.now().toISOString().slice(0, 10);
  }

  private pathFor(day: string): string {
    return join(this.dir, `dpo-${day}.jsonl`);
  }

  poll(): AuditEntryLite[] {
    const day = this.today();
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.offset = 0;
      this.buffer = "";
    }
    const path = this.pathFor(day);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const fd = openSync(path, "r");
    try {
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      this.buffer += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const out: AuditEntryLite[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntryLite);
      } catch {
        // skip malformed
      }
    }
    return out;
  }
}
