// Node >=24 ships a native, experimental Web Storage `localStorage` global.
// When the process is started without a valid `--localstorage-file`, that
// global is a degenerate object whose `getItem`/`setItem`/`clear` methods are
// undefined, and it shadows the working `localStorage` that jsdom installs on
// its window. The repo targets Node >=20 (where no native global exists and
// jsdom owns `localStorage`), so under newer Node the UI tests fail with
// "localStorage.clear is not a function".
//
// Install a spec-compliant in-memory Storage and point both the bare global
// and `window.localStorage` at the same instance, so component code
// (`window.localStorage`) and test code (`localStorage`) share one store
// regardless of Node version.

class MemoryStorage implements Storage {
  #store = new Map<string, string>();

  get length(): number {
    return this.#store.size;
  }

  clear(): void {
    this.#store.clear();
  }

  getItem(key: string): string | null {
    return this.#store.has(key) ? this.#store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.#store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#store.set(key, String(value));
  }
}

const storage = new MemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: storage,
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}
