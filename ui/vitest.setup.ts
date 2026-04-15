/**
 * Vitest global setup — polyfills for Node test environment.
 *
 * The UI test suite uses `environment: "node"` for speed.  A handful of
 * component tests reference `localStorage` (e.g. to clear draft state between
 * tests).  Node 25+ exposes a partial `localStorage` object that is missing
 * standard methods like `clear()`.  Provide a complete in-memory Storage
 * implementation so those calls succeed without pulling in a full DOM
 * environment.
 */

const store = new Map<string, string>();
const storage: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
};
(globalThis as Record<string, unknown>).localStorage = storage;
