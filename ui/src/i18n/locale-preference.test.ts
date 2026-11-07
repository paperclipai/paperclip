// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCALE_STORAGE_KEY,
  localeCoverage,
  localeDisplayName,
  matchLocale,
  readStoredLocale,
  resolveInitialLocale,
  selectableLocales,
  writeStoredLocale,
} from "./locale-preference";
import { availableLocales } from ".";

const english = { a: "One", b: "Two", c: { d: "Three", e: "Four" } };

describe("locale preference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("measures the share of English messages that a locale translates", () => {
    expect(localeCoverage(english, english)).toBe(0);
    expect(localeCoverage({ a: "Um", b: "Dois", c: { d: "Três", e: "Four" } }, english)).toBe(0.75);
    expect(localeCoverage({ a: "Um" }, english)).toBe(0.25);
  });

  it("offers English plus the locales that are mostly translated", () => {
    const locales = {
      en: english,
      "pt-BR": { a: "Um", b: "Dois", c: { d: "Três", e: "Quatro" } },
      de: { a: "Eins", b: "Two", c: { d: "Three", e: "Four" } },
    };
    expect(selectableLocales(locales)).toEqual(["en", "pt-BR"]);
    expect(selectableLocales(locales, 0.2)).toEqual(["en", "de", "pt-BR"]);
  });

  it("includes Brazilian Portuguese in the bundled selectable locales", () => {
    expect(availableLocales).toEqual(expect.arrayContaining(["en", "pt-BR"]));
    expect(availableLocales).not.toContain("de");
  });

  it("matches browser language tags against available locales", () => {
    const available = ["en", "pt-BR"];
    expect(matchLocale("pt-BR", available)).toBe("pt-BR");
    expect(matchLocale("pt_br", available)).toBe("pt-BR");
    expect(matchLocale("pt-PT", available)).toBe("pt-BR");
    expect(matchLocale("en-US", available)).toBe("en");
    expect(matchLocale("fr-FR", available)).toBeNull();
    expect(matchLocale("", available)).toBeNull();
  });

  it("prefers a stored locale, then the browser languages, then English", () => {
    const available = ["en", "pt-BR"];
    expect(resolveInitialLocale({ stored: "pt-BR", languages: ["en-US"], available })).toBe("pt-BR");
    expect(resolveInitialLocale({ stored: "de", languages: ["fr-FR", "pt-BR"], available })).toBe("pt-BR");
    expect(resolveInitialLocale({ stored: null, languages: ["fr-FR"], available })).toBe("en");
  });

  it("persists the locale and tolerates blocked storage", () => {
    writeStoredLocale("pt-BR");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("pt-BR");
    expect(readStoredLocale()).toBe("pt-BR");

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredLocale()).toBeNull();
    expect(() => writeStoredLocale("en")).not.toThrow();
  });

  it("names each locale in its own language", () => {
    expect(localeDisplayName("en")).toBe("English");
    expect(localeDisplayName("pt-BR")).toBe("Português (Brasil)");
  });
});
