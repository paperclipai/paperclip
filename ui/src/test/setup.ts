function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(String(key)) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => entries.delete(String(key)),
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
  };
}

function ensureLocalStorage(target: typeof globalThis) {
  const descriptor = Object.getOwnPropertyDescriptor(target, "localStorage");
  const existing = descriptor && "value" in descriptor ? descriptor.value as Storage | undefined : undefined;

  if (
    existing
    && typeof existing.clear === "function"
    && typeof existing.getItem === "function"
    && typeof existing.setItem === "function"
    && typeof existing.removeItem === "function"
  ) {
    return;
  }

  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}

ensureLocalStorage(globalThis);

if (typeof window !== "undefined") {
  ensureLocalStorage(window);
}
