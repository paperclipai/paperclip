import { describe, expect, it } from "vitest";

import { LOCALE_STORAGE_KEY } from "../i18n/preference";
import { timeAgo } from "./timeAgo";
import { relativeTime } from "./utils";

function ago(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

describe("timeAgo", () => {
  it("keeps the English clock", () => {
    expect(timeAgo(ago(10), "en")).toBe("just now");
    expect(timeAgo(ago(90), "en")).toBe("1m ago");
    expect(timeAgo(ago(2 * 60 * 60), "en")).toBe("2h ago");
    expect(timeAgo(ago(3 * 24 * 60 * 60), "en")).toBe("3d ago");
    expect(timeAgo(ago(8 * 24 * 60 * 60), "en")).toBe("1w ago");
    expect(timeAgo(ago(40 * 24 * 60 * 60), "en")).toBe("1mo ago");
  });

  it("uses Russian unit words for counted ages", () => {
    expect(timeAgo(ago(10), "ru")).toBe("только что");
    expect(timeAgo(ago(90), "ru")).toBe("1 мин назад");
    expect(timeAgo(ago(2 * 60 * 60), "ru")).toBe("2 ч назад");
    expect(timeAgo(ago(3 * 24 * 60 * 60), "ru")).toBe("3 д назад");
    expect(timeAgo(ago(8 * 24 * 60 * 60), "ru")).toBe("1 нед назад");
    expect(timeAgo(ago(40 * 24 * 60 * 60), "ru")).toBe("1 мес назад");
    expect(timeAgo(ago(10), "ru-RU")).toBe("только что");
  });

  it("follows the stored locale when the caller does not pass one", () => {
    const previous = globalThis.localStorage;
    const store = new Map<string, string>([[LOCALE_STORAGE_KEY, "ru"]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      },
    });
    try {
      expect(timeAgo(ago(10))).toBe("только что");
      expect(relativeTime(ago(90), "ru")).toBe("2 мин назад");
      expect(relativeTime(ago(90), "en")).toBe("2m ago");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  });
});
