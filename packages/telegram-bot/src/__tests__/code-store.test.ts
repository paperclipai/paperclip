import { describe, it, expect } from "vitest";
import { CodeStore } from "../state/code-store.js";

describe("CodeStore", () => {
  it("issues 6-digit codes and retrieves payload exactly once", () => {
    let now = 1_000_000;
    const store = new CodeStore({ now: () => now, ttlMs: 60_000 });
    const { code, expiresAt } = store.issue({ chatId: "42", tgUsername: "dinar" });
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(now + 60_000);

    const entry = store.consume(code);
    expect(entry?.chatId).toBe("42");
    expect(entry?.tgUsername).toBe("dinar");

    expect(store.consume(code)).toBeNull();
  });

  it("expires entries past TTL", () => {
    let now = 0;
    const store = new CodeStore({ now: () => now, ttlMs: 1_000 });
    const { code } = store.issue({ chatId: "1" });
    now = 2_000;
    expect(store.consume(code)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("returns null for unknown codes", () => {
    const store = new CodeStore();
    expect(store.consume("000000")).toBeNull();
  });
});
