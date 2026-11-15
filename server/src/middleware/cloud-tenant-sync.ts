import type { Db } from "@paperclipai/db";

const DEBOUNCE_MS = 5_000;
const MAX_COMPLETED_USERS = 1_000;

type SyncState = {
  fingerprint?: string;
  syncedAt?: number;
  pending?: { fingerprint: string; promise: Promise<void> };
};

const statesByDatabase = new WeakMap<Db, Map<string, SyncState>>();

function prune(states: Map<string, SyncState>, now: number) {
  for (const [userId, state] of states) {
    if (!state.pending && (state.syncedAt === undefined || state.syncedAt <= now - DEBOUNCE_MS)) {
      states.delete(userId);
    }
  }
  let completed = [...states.values()].filter(state => !state.pending).length;
  for (const [userId, state] of states) {
    if (completed <= MAX_COMPLETED_USERS) break;
    if (!state.pending) {
      states.delete(userId);
      completed -= 1;
    }
  }
}

/**
 * Serialize writes for a user (the auth user row is shared across companies).
 * Only the last queued context can be shared: A -> B -> A must still apply A
 * after B. Failed/partial syncs never populate the successful-write debounce.
 * This caches writes only; callers must still resolve current authority.
 */
export async function syncCloudTenantWrites(
  db: Db,
  userId: string,
  fingerprint: string,
  sync: () => Promise<void>,
): Promise<void> {
  let states = statesByDatabase.get(db);
  if (!states) {
    states = new Map();
    statesByDatabase.set(db, states);
  }
  prune(states, Date.now());
  let state = states.get(userId);
  if (!state) {
    state = {};
    states.set(userId, state);
  }
  if (state.pending?.fingerprint === fingerprint) return state.pending.promise;

  const previous = state.pending?.promise;
  const run = async () => {
    if (state.fingerprint === fingerprint && state.syncedAt !== undefined && state.syncedAt > Date.now() - DEBOUNCE_MS) {
      return;
    }
    // A failed different context can have partially written the user or role.
    // Invalidate the previous success before touching the database so a retry
    // of that old context repairs it rather than incorrectly skipping writes.
    state.fingerprint = undefined;
    state.syncedAt = undefined;
    await sync();
    state.fingerprint = fingerprint;
    state.syncedAt = Date.now();
  };
  const promise = previous ? previous.catch(() => {}).then(run) : Promise.resolve().then(run);
  state.pending = { fingerprint, promise };
  const settle = () => {
    if (state.pending?.promise === promise) {
      state.pending = undefined;
      states.delete(userId);
      states.set(userId, state);
      prune(states, Date.now());
    }
  };
  void promise.then(settle, settle);
  return promise;
}
