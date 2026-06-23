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

// Pin the browser language in tests so the i18n locale auto-detection
// (src/i18n/language.ts) is deterministic regardless of the host machine's
// locale. Production still detects the real browser language; tests assert the
// English baseline. Applied before any module (including i18n) is imported.
function pinNavigatorLanguage(nav: Navigator | undefined) {
  if (!nav) return;
  try {
    Object.defineProperty(nav, "language", { configurable: true, value: "en-US" });
    Object.defineProperty(nav, "languages", { configurable: true, value: ["en-US"] });
  } catch {
    /* navigator may be locked down; i18n then falls back to the default locale */
  }
}
pinNavigatorLanguage(typeof navigator !== "undefined" ? navigator : undefined);

// jsdom does not implement Element.prototype.scrollIntoView. Several surfaces
// (e.g. IssueChatThread's auto-scroll-to-latest) call it during normal render,
// so provide a no-op default. Tests that assert on scroll behaviour override
// this on the prototype themselves and restore it afterwards.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
