import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { NotifierEventType } from "./types.js";

const FILE_VERSION = 1;
const DEFAULT_MAX_PER_TYPE = 5_000;

type Persisted = {
  version: number;
  seen: Record<NotifierEventType, string[]>;
};

export type DedupOptions = {
  filePath?: string;
  maxPerType?: number;
};

export function defaultDedupPath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "paperclip-tg-bot", "seen.json");
}

const EMPTY: Persisted = {
  version: FILE_VERSION,
  seen: { interaction: [], approval: [], blocked: [], done: [], weekly_digest: [] },
};

/**
 * Persists notification dedup state (per-type "seen" event keys) to a JSON
 * file on disk. We deliberately avoid SQLite to keep the bot a zero-native-deps
 * package — the dataset is small (4 buckets × ≤5k entries each).
 */
export class NotifierDedup {
  private state: Persisted = clone(EMPTY);
  private dirty = false;
  private readonly filePath: string;
  private readonly maxPerType: number;
  private loaded = false;

  constructor(opts: DedupOptions = {}) {
    this.filePath = opts.filePath ?? defaultDedupPath();
    this.maxPerType = opts.maxPerType ?? DEFAULT_MAX_PER_TYPE;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const buf = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(buf) as Partial<Persisted>;
      if (parsed && typeof parsed === "object" && parsed.seen) {
        for (const k of Object.keys(EMPTY.seen) as NotifierEventType[]) {
          const arr = parsed.seen[k];
          this.state.seen[k] = Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    this.loaded = true;
  }

  has(type: NotifierEventType, key: string): boolean {
    return this.state.seen[type].includes(key);
  }

  remember(type: NotifierEventType, key: string): void {
    if (this.has(type, key)) return;
    const bucket = this.state.seen[type];
    bucket.push(key);
    if (bucket.length > this.maxPerType) {
      bucket.splice(0, bucket.length - this.maxPerType);
    }
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: Persisted = { version: FILE_VERSION, seen: this.state.seen };
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }

  snapshot(): Persisted {
    return clone(this.state);
  }
}

function clone(p: Persisted): Persisted {
  return {
    version: p.version,
    seen: {
      interaction: [...p.seen.interaction],
      approval: [...p.seen.approval],
      blocked: [...p.seen.blocked],
      done: [...p.seen.done],
      weekly_digest: [...p.seen.weekly_digest],
    },
  };
}
