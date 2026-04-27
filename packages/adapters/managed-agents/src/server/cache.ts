import { createHash } from "node:crypto";

// Tiny in-memory TTL cache keyed by (namespace, query) for Cornerstone
// context retrieval. 5-minute TTL per spike spec. In-process only — a
// production version should sit in Redis/Supabase.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const TTL_MS = 5 * 60 * 1000;

function hash(namespace: string, query: string): string {
  return createHash("sha256").update(`${namespace}::${query}`).digest("hex").slice(0, 24);
}

export function cacheGet<T>(namespace: string, query: string): T | null {
  const key = hash(namespace, query);
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cachePut<T>(namespace: string, query: string, value: T): void {
  const key = hash(namespace, query);
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}
