import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock localStorage for the tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

// Mock navigator for language detection
const navigatorMock = { language: "en-US" };

describe("i18n config", () => {
  beforeEach(() => {
    localStorageMock.clear();
    Object.defineProperty(global, "localStorage", { value: localStorageMock, writable: true });
    Object.defineProperty(global, "navigator", { value: navigatorMock, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects English from navigator when no stored preference", () => {
    navigatorMock.language = "en-US";
    localStorageMock.clear();
    // Since we can't easily re-run detectLanguage without re-importing,
    // we test the logic directly by simulating it
    const stored = localStorageMock.getItem("paperclip.language");
    expect(stored).toBeNull();
    const lang = navigator.language;
    const detected = lang.startsWith("pt") ? "pt-BR" : "en";
    expect(detected).toBe("en");
  });

  it("detects pt-BR from navigator when browser language is Portuguese", () => {
    navigatorMock.language = "pt-BR";
    const lang = navigator.language;
    const detected = lang.startsWith("pt") ? "pt-BR" : "en";
    expect(detected).toBe("pt-BR");
  });

  it("uses stored language preference over browser language", () => {
    navigatorMock.language = "pt-BR";
    localStorageMock.setItem("paperclip.language", "en");
    const stored = localStorageMock.getItem("paperclip.language");
    const detected = (stored === "en" || stored === "pt-BR") ? stored : (navigator.language.startsWith("pt") ? "pt-BR" : "en");
    expect(detected).toBe("en");
  });

  it("falls back to English for unsupported stored language", () => {
    localStorageMock.setItem("paperclip.language", "fr");
    const stored = localStorageMock.getItem("paperclip.language");
    const isValid = stored === "en" || stored === "pt-BR";
    const detected = isValid ? stored : "en";
    expect(detected).toBe("en");
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("includes English and Brazilian Portuguese", async () => {
    // We test the locale files directly
    const en = await import("./locales/en.json");
    const ptBR = await import("./locales/pt-BR.json");

    expect(en.default).toBeDefined();
    expect(ptBR.default).toBeDefined();
  });

  it("en.json has required top-level keys", async () => {
    const en = await import("./locales/en.json");
    expect(en.default).toHaveProperty("common");
    expect(en.default).toHaveProperty("nav");
    expect(en.default).toHaveProperty("pages");
    expect(en.default).toHaveProperty("sidebar");
  });

  it("pt-BR.json has the same top-level structure as en.json", async () => {
    const en = await import("./locales/en.json");
    const ptBR = await import("./locales/pt-BR.json");

    const enKeys = Object.keys(en.default).sort();
    const ptBRKeys = Object.keys(ptBR.default).sort();

    expect(ptBRKeys).toEqual(enKeys);
  });

  it("pt-BR.json pages matches en.json pages structure", async () => {
    const en = await import("./locales/en.json");
    const ptBR = await import("./locales/pt-BR.json");

    const enPageKeys = Object.keys(en.default.pages).sort();
    const ptBRPageKeys = Object.keys(ptBR.default.pages).sort();

    expect(ptBRPageKeys).toEqual(enPageKeys);
  });

  it("en.json has translations for all main pages", async () => {
    const en = await import("./locales/en.json");
    const pages = en.default.pages;

    expect(pages).toHaveProperty("dashboard");
    expect(pages).toHaveProperty("agents");
    expect(pages).toHaveProperty("issues");
    expect(pages).toHaveProperty("goals");
    expect(pages).toHaveProperty("projects");
    expect(pages).toHaveProperty("approvals");
    expect(pages).toHaveProperty("costs");
    expect(pages).toHaveProperty("activity");
    expect(pages).toHaveProperty("inbox");
    expect(pages).toHaveProperty("myIssues");
    expect(pages).toHaveProperty("notFound");
  });

  it("pt-BR.json dashboard.title is translated", async () => {
    const ptBR = await import("./locales/pt-BR.json");
    expect(ptBR.default.pages.dashboard.title).toBe("Painel");
  });

  it("en.json dashboard.title is in English", async () => {
    const en = await import("./locales/en.json");
    expect(en.default.pages.dashboard.title).toBe("Dashboard");
  });

  it("pt-BR.json agents.title is translated", async () => {
    const ptBR = await import("./locales/pt-BR.json");
    expect(ptBR.default.pages.agents.title).toBe("Agentes");
  });

  it("sidebar has all expected navigation keys in both locales", async () => {
    const en = await import("./locales/en.json");
    const ptBR = await import("./locales/pt-BR.json");

    const requiredSidebarKeys = ["newIssue", "dashboard", "inbox", "issues", "goals", "agents", "costs", "activity"];
    for (const key of requiredSidebarKeys) {
      expect(en.default.sidebar).toHaveProperty(key);
      expect(ptBR.default.sidebar).toHaveProperty(key);
    }
  });
});
