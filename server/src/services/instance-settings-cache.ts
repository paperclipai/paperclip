import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

export const INSTANCE_SETTINGS_CACHE_TTL_MS = 2_000;

type Entry = { generation: number; at: number; value?: unknown; pending?: Promise<unknown> };

let generation = 0;
const entries = new WeakMap<object, Entry>();

export function invalidateInstanceSettingsCache() {
  generation += 1;
}

export async function readThroughInstanceSettings<T>(db: object, load: () => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) return load();
  const current = entries.get(db);
  if (current && current.generation === generation) {
    if ("value" in current && Date.now() - current.at < INSTANCE_SETTINGS_CACHE_TTL_MS) {
      return structuredClone(current.value as T);
    }
    if (current.pending) return structuredClone(await (current.pending as Promise<T>));
  }
  const startedAt = Date.now();
  const startedGeneration = generation;
  const entry: Entry = { generation: startedGeneration, at: startedAt };
  const pending = load();
  entry.pending = pending;
  entries.set(db, entry);
  try {
    const value = await pending;
    if (entries.get(db) === entry) {
      if (generation === startedGeneration) entries.set(db, { generation: startedGeneration, at: startedAt, value });
      else entries.delete(db);
    }
    return structuredClone(value);
  } catch (error) {
    if (entries.get(db) === entry) entries.delete(db);
    throw error;
  }
}
