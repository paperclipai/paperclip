const storageEntries = new Map<string, string>();

// Pin the i18n locale to English in tests so that lib/*.ts modules that call
// `t(...)` at runtime produce stable English assertions, regardless of the
// developer's OS language detected by i18next-browser-languagedetector.
storageEntries.set("paperclip_locale", "en");

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

// Force English locale for tests after the i18n module has self-initialised.
// This guarantees deterministic English copy from `t(...)` calls regardless
// of how the browser language detector resolved the locale at import time.
const { i18n } = await import("./src/i18n");
if (i18n.language !== "en") {
  await i18n.changeLanguage("en");
}
