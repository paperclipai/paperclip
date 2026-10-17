// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, getCurrentLocale, resolveInitialLocale } from "./index";

describe("i18n storage resilience and resolution", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("resolves stored locale from localStorage when available", () => {
    window.localStorage.setItem("paperclip.locale", "pt-BR");
    expect(resolveInitialLocale()).toBe("pt-BR");
  });

  it("falls back gracefully when localStorage throws an exception", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage access denied");
    });

    expect(() => resolveInitialLocale()).not.toThrow();
    const resolved = resolveInitialLocale();
    expect(typeof resolved).toBe("string");
  });

  it("switches language in-memory even if localStorage.setItem fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError or blocked storage");
    });

    expect(() => changeLanguage("pt-PT")).not.toThrow();
    expect(getCurrentLocale()).toBe("pt-PT");
  });

  it("stores the new language when localStorage is writable", () => {
    changeLanguage("pt-BR");
    expect(window.localStorage.getItem("paperclip.locale")).toBe("pt-BR");
    expect(getCurrentLocale()).toBe("pt-BR");
  });
});
