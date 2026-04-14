import { beforeEach } from "vitest";

type StorageKey = "localStorage" | "sessionStorage";

function createStorageMock() {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
  };
}

function ensureStorage(target: object, storageKey: StorageKey) {
  const existing = (target as Record<string, unknown>)[storageKey] as
    | {
        getItem?: unknown;
        setItem?: unknown;
        removeItem?: unknown;
        clear?: unknown;
      }
    | undefined;

  if (
    existing &&
    typeof existing.getItem === "function" &&
    typeof existing.setItem === "function" &&
    typeof existing.removeItem === "function" &&
    typeof existing.clear === "function"
  ) {
    return;
  }

  Object.defineProperty(target, storageKey, {
    configurable: true,
    value: createStorageMock(),
  });
}

beforeEach(() => {
  const target = typeof window !== "undefined" ? window : globalThis;
  ensureStorage(target, "localStorage");
  ensureStorage(target, "sessionStorage");
});
