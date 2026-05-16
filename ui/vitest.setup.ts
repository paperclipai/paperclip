const storageEntries = new Map<string, string>();

// Initialize i18next for test environment (use actual i18next instance per Gemini advisory)
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./src/i18n/locales/en.json";

const i18nForTest = i18n.createInstance();
i18nForTest.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  initImmediate: false,
});
// Components use t() calls with English fallback, but in test environment
// we mock the hook to return the key's fallback value (2nd argument) or the key itself.
import { vi } from "vitest";

const mockTFunction = vi.fn((key: string, ...args: unknown[]) => {
  // args[0] can be an object with interpolation variables like { count, name }
  const interpVars = (args[0] && typeof args[0] === "object") ? (args[0] as Record<string, unknown>) : {};
  // Try to resolve from en.json
  try {
    const en = require("./src/i18n/locales/en.json");
    const parts = key.split(".");
    let value: unknown = en;
    for (const part of parts) {
      if (value && typeof value === "object" && part in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return (args[0] && typeof args[0] === "string") ? args[0] : "";
      }
    }
    if (typeof value === "string") {
      return value.replace(/\{\{(\w+)\}\}/g, (_match: string, varName: string) => {
        return interpVars[varName] !== undefined ? String(interpVars[varName]) : "";
      });
    }
    return (args[0] && typeof args[0] === "string") ? args[0] : "";
  } catch {
    return (args[0] && typeof args[0] === "string") ? args[0] : "";
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mockTFunction,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

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
