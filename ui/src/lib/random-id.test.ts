import { afterEach, describe, expect, it } from "vitest";
import { randomId } from "./random-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const nativeRandomUUID = crypto.randomUUID;

afterEach(() => {
  crypto.randomUUID = nativeRandomUUID;
});

describe("randomId", () => {
  it("returns a UUID in a secure context", () => {
    expect(randomId()).toMatch(UUID_PATTERN);
  });

  it("falls back to a random UUID when randomUUID is unavailable", () => {
    // Insecure origins (plain-HTTP LAN boards) hide crypto.randomUUID.
    crypto.randomUUID = undefined as unknown as Crypto["randomUUID"];
    expect(randomId()).toMatch(UUID_PATTERN);
  });

  it("keeps fallback ids distinct", () => {
    crypto.randomUUID = undefined as unknown as Crypto["randomUUID"];
    const ids = new Set([randomId(), randomId(), randomId()]);
    expect(ids.size).toBe(3);
  });
});
