export interface KvEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface KvStateSnapshot {
  entries: KvEntry[];
  count: number;
  revision: number;
}

/**
 * In-memory key/value store shared by the MCP tools and the values UI within a
 * single process. State lives only for the process lifetime — there is no
 * persistence, by design, so the demo always starts empty.
 */
export class KvStore {
  private readonly entries = new Map<string, KvEntry>();
  private revisionCounter = 0;

  get revision(): number {
    return this.revisionCounter;
  }

  set(key: string, value: string): KvEntry {
    const entry: KvEntry = { key, value, updatedAt: new Date().toISOString() };
    this.entries.set(key, entry);
    this.revisionCounter += 1;
    return entry;
  }

  get(key: string): KvEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    const existed = this.entries.delete(key);
    if (existed) this.revisionCounter += 1;
    return existed;
  }

  list(prefix?: string): KvEntry[] {
    const normalizedPrefix = prefix?.trim() ?? "";
    const all = Array.from(this.entries.values());
    const filtered = normalizedPrefix
      ? all.filter((entry) => entry.key.startsWith(normalizedPrefix))
      : all;
    return filtered.sort((a, b) => a.key.localeCompare(b.key));
  }

  snapshot(): KvStateSnapshot {
    const entries = this.list();
    return { entries, count: entries.length, revision: this.revisionCounter };
  }
}
