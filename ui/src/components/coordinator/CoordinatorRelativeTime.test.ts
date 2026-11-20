import { describe, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY } from "@/i18n/preference";
import { coordinatorRelativeLabel } from "./CoordinatorRelativeTime";
const now = Date.parse("2026-10-26T12:00:00Z");
describe("Coordinator message time", () => {
  it("uses the durable timestamp and handles clock skew without future ages", () => {
    expect(coordinatorRelativeLabel("2026-10-26T11:58:00Z", now)).toBe("2m ago");
    expect(coordinatorRelativeLabel("2026-10-26T10:00:00Z", now)).toBe("2h ago");
    expect(coordinatorRelativeLabel("2026-10-25T12:00:00Z", now)).toBe("1d ago");
    expect(coordinatorRelativeLabel("2026-10-26T12:01:00Z", now)).toBe("Just now");
  });
  it("uses Russian unit words when the stored locale is Russian", () => {
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
      expect(coordinatorRelativeLabel("2026-10-26T11:58:00Z", now)).toBe("2 мин назад");
      expect(coordinatorRelativeLabel("2026-10-26T10:00:00Z", now)).toBe("2 ч назад");
      expect(coordinatorRelativeLabel("2026-10-25T12:00:00Z", now)).toBe("1 д назад");
      expect(coordinatorRelativeLabel("2026-10-26T12:01:00Z", now)).toBe("Только что");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  });
  it("does not invent a time for an invalid timestamp", () => expect(coordinatorRelativeLabel("invalid", now)).toBeNull());
});
