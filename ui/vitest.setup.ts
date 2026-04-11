const storage = new Map<string, string>();

const storageShim = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(String(key), String(value));
  },
  removeItem(key: string) {
    storage.delete(String(key));
  },
  clear() {
    storage.clear();
  },
  key(index: number) {
    return Array.from(storage.keys())[index] ?? null;
  },
  get length() {
    return storage.size;
  },
};

if (typeof globalThis.localStorage !== "object" || typeof globalThis.localStorage?.clear !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    value: storageShim,
    configurable: true,
  });
}
