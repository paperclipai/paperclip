import { describe, expect, it } from "vitest";
import { redactSensitive } from "../middleware/redact-sensitive.js";

describe("redactSensitive", () => {
  it("redacts a plaintext password field without mutating the input", () => {
    const body = { email: "user@example.com", password: "founding6gomez6croaking" };

    const out = redactSensitive(body) as Record<string, unknown>;

    expect(out.email).toBe("user@example.com");
    expect(out.password).toBe("[REDACTED]");
    expect(body.password).toBe("founding6gomez6croaking");
  });

  it("redacts password keys regardless of casing", () => {
    expect((redactSensitive({ Password: "x" }) as Record<string, unknown>).Password).toBe("[REDACTED]");
    expect((redactSensitive({ PASSWORD: "x" }) as Record<string, unknown>).PASSWORD).toBe("[REDACTED]");
  });

  it("redacts known credential-shaped keys", () => {
    const out = redactSensitive({
      currentPassword: "a",
      newPassword: "b",
      access_token: "c",
      refresh_token: "d",
      api_key: "e",
      authorization: "Bearer f",
    }) as Record<string, string>;

    for (const value of Object.values(out)) {
      expect(value).toBe("[REDACTED]");
    }
  });

  it("does not redact bare token fields used for cursors", () => {
    const out = redactSensitive({ token: "next-page-cursor", limit: 20 }) as Record<string, unknown>;

    expect(out.token).toBe("next-page-cursor");
    expect(out.limit).toBe(20);
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSensitive({
      user: { email: "user@example.com", password: "secret-pass" },
      tokens: [{ access_token: "t1" }, { access_token: "t2" }],
    }) as Record<string, unknown>;

    expect((out.user as Record<string, unknown>).email).toBe("user@example.com");
    expect((out.user as Record<string, unknown>).password).toBe("[REDACTED]");
    const tokens = out.tokens as Array<Record<string, unknown>>;
    expect(tokens[0].access_token).toBe("[REDACTED]");
    expect(tokens[1].access_token).toBe("[REDACTED]");
  });

  it("caps recursion depth so cycles do not pin the logger", () => {
    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;

    expect(() => redactSensitive(cycle)).not.toThrow();
  });
});
