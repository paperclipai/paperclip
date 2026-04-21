type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
  readonly length: number;
};

const createStorage = (): StorageLike => {
  const entries = new Map<string, string>();

  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(String(key), String(value));
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    key: (index) => Array.from(entries.keys())[index] ?? null,
    get length() {
      return entries.size;
    },
  };
};

const hasCompleteStorage = (value: unknown): value is StorageLike => {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<StorageLike>;
  return (
    typeof candidate.getItem === "function"
    && typeof candidate.setItem === "function"
    && typeof candidate.removeItem === "function"
    && typeof candidate.clear === "function"
    && typeof candidate.key === "function"
  );
};

const installStorage = (target: object, storage: StorageLike) => {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: storage,
  });
};

if (!hasCompleteStorage(globalThis.localStorage)) {
  const storage = createStorage();
  installStorage(globalThis, storage);

  if (typeof window !== "undefined" && window !== globalThis) {
    installStorage(window, storage);
  }
}
