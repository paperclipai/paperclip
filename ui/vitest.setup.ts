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

// Avoid touching Node's native globalThis.localStorage getter in pure-node
// environments, which emits ExperimentalWarning (--localstorage-file) on every
// worker process.
if (typeof window === "undefined") {
  installStorageMock(globalThis as unknown as Record<string, unknown>);
} else {
  const winStorage = window.localStorage;
  if (
    typeof winStorage?.getItem !== "function"
    || typeof winStorage?.setItem !== "function"
    || typeof winStorage?.removeItem !== "function"
    || typeof winStorage?.clear !== "function"
  ) {
    installStorageMock(window as unknown as Record<string, unknown>);
  }
  if (globalThis.localStorage !== window.localStorage) {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: window.localStorage,
    });
  }
}

// Configure React act() environment globally so jsdom tests do not emit
// "The current testing environment is not configured to support act(...)"
// warnings on every render.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Suppress React's repetitive multi-line act(...) stderr spam (which generated
// 20-50 MB of CI log output per shard) and TanStack Query's seeded-cache
// "No queryFn was passed as an option" noise while preserving all real
// console.error messages and keeping console.error spyable in individual tests.
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (
    typeof first === "string"
    && (
      first.includes("inside a test was not wrapped in act(...)")
      || first.includes("The current testing environment is not configured to support act(...)")
      || first.includes("No queryFn was passed as an option")
    )
  ) {
    return;
  }
  originalConsoleError(...args);
};

// jsdom does not implement scrollIntoView, window.scrollTo, window.open, or
// HTMLCanvasElement.prototype.getContext. Provide writable/configurable no-op
// defaults so normal renders do not spam jsdom "Not implemented" stderr errors
// while tests remain free to spy on or override them.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}
