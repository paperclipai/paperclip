import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts credential fields from auth request bodies", () => {
    const signInBody = {
      email: "user@example.com",
      password: "super-secret-password",
    };
    const result = sanitizeRecord(signInBody);
    expect(result.email).toBe("user@example.com");
    expect(result.password).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts change-password request bodies with multiple credential fields", () => {
    const changePasswordBody = {
      currentPassword: "old-pass",
      newPassword: "new-pass",
      userId: "user-123",
    };
    const result = sanitizeRecord(changePasswordBody);
    expect(result.currentPassword).toBe(REDACTED_EVENT_VALUE);
    expect(result.newPassword).toBe(REDACTED_EVENT_VALUE);
    expect(result.userId).toBe("user-123");
  });

  it("preserves non-sensitive fields in error context bodies", () => {
    const errorContextBody = {
      email: "test@test.com",
      password: "leaked",
      rememberMe: true,
    };
    const result = sanitizeRecord(errorContextBody);
    expect(result.password).toBe(REDACTED_EVENT_VALUE);
    expect(result.email).toBe("test@test.com");
    expect(result.rememberMe).toBe(true);
  });

  it("redacts bare 'token' key not covered by compound forms", () => {
    const body = {
      token: "raw-bearer-value",
      userId: "user-123",
      email: "user@example.com",
    };
    const result = sanitizeRecord(body);
    expect(result.token).toBe(REDACTED_EVENT_VALUE);
    expect(result.userId).toBe("user-123");
    expect(result.email).toBe("user@example.com");
  });
});
