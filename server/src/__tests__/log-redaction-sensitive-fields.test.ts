import { describe, it, expect } from "vitest";
import { redactSensitiveFields } from "../middleware/logger.js";

describe("redactSensitiveFields", () => {
  it("redacts password field", () => {
    expect(redactSensitiveFields({ password: "secret123" })).toEqual({ password: "[REDACTED]" });
  });

  it("redacts nested fields", () => {
    const input = { user: { token: "abc", name: "Alice" } };
    const result = redactSensitiveFields(input);
    expect(result).toEqual({ user: { token: "[REDACTED]", name: "Alice" } });
  });

  it("handles arrays", () => {
    const input = { items: [{ apiKey: "key1" }, { name: "ok" }] };
    const result = redactSensitiveFields(input);
    expect(result).toEqual({ items: [{ apiKey: "[REDACTED]" }, { name: "ok" }] });
  });

  it("returns non-objects unchanged", () => {
    expect(redactSensitiveFields("string")).toBe("string");
    expect(redactSensitiveFields(null)).toBe(null);
    expect(redactSensitiveFields(42)).toBe(42);
  });

  it("redacts all sensitive key variants", () => {
    const input = {
      password: "x", secret: "x", token: "x",
      apiKey: "x", api_key: "x", authorization: "x", cookie: "x",
      safe: "keep",
    };
    const result = redactSensitiveFields(input) as Record<string, string>;
    expect(result.safe).toBe("keep");
    expect(result.password).toBe("[REDACTED]");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
    expect(result.cookie).toBe("[REDACTED]");
  });
});
