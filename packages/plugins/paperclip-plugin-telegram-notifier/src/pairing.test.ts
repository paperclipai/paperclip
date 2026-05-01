import { describe, expect, it } from "vitest";
import {
  chatLabel,
  codesMatch,
  generateVerificationCode,
  isHandshakeExpired,
  newHandshakeExpiry,
} from "./pairing.js";

describe("generateVerificationCode", () => {
  it("returns a 6-character uppercase code", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it("excludes ambiguous characters (0, O, 1, I, L)", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateVerificationCode();
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });
});

describe("codesMatch", () => {
  it("matches case-insensitively", () => {
    expect(codesMatch("ABC123", "abc123")).toBe(true);
    expect(codesMatch("aBc123", "AbC123")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(codesMatch("  ABC123  ", "ABC123")).toBe(true);
  });

  it("rejects mismatches", () => {
    expect(codesMatch("ABC123", "ABC124")).toBe(false);
    expect(codesMatch("ABC", "ABC123")).toBe(false); // length mismatch
  });
});

describe("isHandshakeExpired", () => {
  it("treats past expiry as expired", () => {
    expect(
      isHandshakeExpired(
        { stage: "awaiting_chat", targetCompanyId: "co-1", expiresAt: new Date(0).toISOString() },
        Date.now(),
      ),
    ).toBe(true);
  });

  it("treats future expiry as not expired", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      isHandshakeExpired({ stage: "awaiting_chat", targetCompanyId: "co-1", expiresAt: future }, Date.now()),
    ).toBe(false);
  });

  it("treats malformed expiry as expired", () => {
    expect(
      isHandshakeExpired({
        stage: "awaiting_chat",
        targetCompanyId: "co-1",
        expiresAt: "not-a-date",
      }),
    ).toBe(true);
  });
});

describe("newHandshakeExpiry", () => {
  it("returns an ISO string ~10 minutes in the future", () => {
    const now = Date.now();
    const expiry = Date.parse(newHandshakeExpiry(now));
    expect(expiry - now).toBeGreaterThanOrEqual(9 * 60_000);
    expect(expiry - now).toBeLessThanOrEqual(11 * 60_000);
  });
});

describe("chatLabel", () => {
  it("prefers @username when present", () => {
    expect(
      chatLabel({ id: 1, type: "private", username: "alice", first_name: "A" }),
    ).toBe("@alice");
  });

  it("falls back to chat title for groups/channels", () => {
    expect(chatLabel({ id: -1, type: "group", title: "Team Chat" })).toBe(
      "Team Chat",
    );
  });

  it("composes first/last name when no username or title", () => {
    expect(
      chatLabel({
        id: 1,
        type: "private",
        first_name: "Alice",
        last_name: "Smith",
      }),
    ).toBe("Alice Smith");
  });

  it("returns chat:<id> when nothing else is known", () => {
    expect(chatLabel({ id: 42, type: "private" })).toBe("chat:42");
  });
});
