import { describe, expect, it } from "vitest";
import { redactSensitive, stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";

describe("redactSensitive", () => {
  it("redacts a plaintext password field on a sign-in body", () => {
    const body = { email: "user@example.com", password: "founding6gomez6croaking" };

    const out = redactSensitive(body) as Record<string, unknown>;

    expect(out.email).toBe("user@example.com");
    expect(out.password).toBe("[REDACTED]");
    expect((body as Record<string, unknown>).password).toBe("founding6gomez6croaking");
  });

  it("redacts password key regardless of casing", () => {
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

  it("redacts an OAuth provider's error_description and error_uri from a callback query", () => {
    const out = redactSensitive({
      state: "paperclip-state",
      error: "access_denied",
      error_description: "\u001b[31mPaste your recovery key\u001b[0m sk-live-canary",
      error_uri: "https://attacker.example/explain?leak=sk-live-canary",
    }) as Record<string, unknown>;

    // The `error` code is Paperclip's one allowlisted label, so it stays legible
    // in logs; the provider's prose does not.
    expect(out.error).toBe("access_denied");
    expect(out.state).toBe("paperclip-state");
    expect(out.error_description).toBe("[REDACTED]");
    expect(out.error_uri).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("sk-live-canary");
    expect(JSON.stringify(out)).not.toContain("\\u001b");
  });

  it("redacts bare value and token fields recursively", () => {
    const out = redactSensitive({
      token: "secret-token",
      nested: { value: "secret-value" },
      entries: [{ value: "array-secret" }],
      limit: 20,
    }) as Record<string, unknown>;

    expect(out.token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).value).toBe("[REDACTED]");
    expect((out.entries as Array<Record<string, unknown>>)[0].value).toBe("[REDACTED]");
    expect(out.limit).toBe(20);
    expect(JSON.stringify(out)).not.toMatch(/secret-token|secret-value|array-secret/);
  });

  it("strips secret-bearing query and fragment values from source URLs", () => {
    const out = redactSensitive({
      source: "https://github.com/acme/private-skill?token=secret#token=secret",
    }) as Record<string, unknown>;

    expect(out.source).toBe("https://github.com/acme/private-skill");
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

  it("leaves primitives and non-sensitive keys untouched", () => {
    const body = { email: "a@b.c", name: "Alice", count: 7, active: true, missing: null };

    expect(redactSensitive(body)).toEqual(body);
  });

  it("returns primitives unchanged", () => {
    expect(redactSensitive("hello")).toBe("hello");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(undefined)).toBe(undefined);
  });

  it("caps recursion depth so cycles do not pin the logger", () => {
    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;

    expect(() => redactSensitive(cycle)).not.toThrow();
  });

  it("omits deeply-nested arrays at the depth cap instead of leaking null entries to JSON", () => {
    // Build an object whose array field is reached at MAX_DEPTH. Recursing
    // into the array elements would exceed the cap; without the array-level
    // guard, `value.map` would produce `[undefined, ...]` which JSON.stringify
    // renders as `[null, ...]`. Object properties at the same cap are
    // already absent from the JSON output (JSON.stringify skips undefined
    // values on objects), so this test pins the array path to the same
    // contract: silently absent, not visible as nulls.
    let payload: Record<string, unknown> = { values: [1, 2, 3] };
    for (let i = 0; i < 5; i++) payload = { nested: payload };

    const out = redactSensitive(payload);

    const json = JSON.stringify(out);
    expect(json).not.toContain("null");
    expect(json).not.toContain("[1,2,3]");
  });
});

describe("stripSecretBearingUrlParts", () => {
  it("keeps a request path legible while dropping its complete query and fragment", () => {
    expect(stripSecretBearingUrlParts(
      "/api/tools/oauth/callback?code=authorization-code&error_description=provider-prose#fragment",
    )).toBe("/api/tools/oauth/callback");
  });
});
