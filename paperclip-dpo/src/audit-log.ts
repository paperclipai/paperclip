import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AuditEntry } from "./types.js";

export function hashPrompt(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export interface AuditLogOptions {
  dir: string;
}

export class AuditLog {
  private dir: string;

  constructor(opts: AuditLogOptions) {
    this.dir = opts.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  write(entry: AuditEntry): void {
    const day = entry.ts.slice(0, 10);
    const file = join(this.dir, `dpo-${day}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  }
}
