// React 19 only exposes `act` from the development build of `react`. Vitest by default
// runs with NODE_ENV=test, which makes Node resolve `react` to its production CJS bundle
// — that bundle does not export `act`, so any test using `import { act } from "react"`
// fails with "(0 , act) is not a function". Force the development build here, before
// any test file imports `react`. Tracked in KSI-712.
if (process.env.NODE_ENV !== "development") {
  process.env.NODE_ENV = "development";
}

const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}
