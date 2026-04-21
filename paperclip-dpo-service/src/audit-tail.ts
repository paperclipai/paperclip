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
  day: string;
}

export class AuditTailer {
  private readonly path: string;
  private offset = 0;
  private buffer = "";

  constructor(opts: AuditTailerOptions) {
    this.path = join(opts.dir, `dpo-${opts.day}.jsonl`);
  }

  poll(): AuditEntryLite[] {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const fd = openSync(this.path, "r");
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
