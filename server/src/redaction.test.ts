import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, sanitizeRecord, redactEventPayload } from "./redaction.js";

// ============================================================================
// sanitizeRecord
// ============================================================================

describe("sanitizeRecord", () => {
  it("passes through non-sensitive keys unchanged", () => {
    const record = { name: "agent-1", status: "active" };
    expect(sanitizeRecord(record)).toEqual({ name: "agent-1", status: "active" });
  });

  it("redacts string value for sensitive key 'apiKey'", () => {
    const record = { apiKey: "sk-abc123" };
    const result = sanitizeRecord(record);
    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts string value for 'api_key' (underscore variant)", () => {
    const record = { api_key: "secret-value" };
    expect(sanitizeRecord(record).api_key).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'password' key", () => {
    const record = { password: "hunter2" };
    expect(sanitizeRecord(record).password).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'secret' key", () => {
    const record = { secret: "top-secret" };
    expect(sanitizeRecord(record).secret).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'authorization' key", () => {
    const record = { authorization: "Bearer token123" };
    expect(sanitizeRecord(record).authorization).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'bearer' key", () => {
    const record = { bearer: "tok" };
    expect(sanitizeRecord(record).bearer).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'cookie' key", () => {
    const record = { cookie: "session=abc" };
    expect(sanitizeRecord(record).cookie).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts 'jwt' key", () => {
    const record = { jwt: "eyJ..." };
    expect(sanitizeRecord(record).jwt).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts JWT-shaped string values even for non-sensitive keys", () => {
    const jwtValue = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const record = { someKey: jwtValue };
    expect(sanitizeRecord(record).someKey).toBe(REDACTED_EVENT_VALUE);
  });

  it("preserves secret_ref binding for sensitive key", () => {
    const binding = { type: "secret_ref", secretId: "sec-123" };
    const record = { apiKey: binding };
    const result = sanitizeRecord(record);
    expect(result.apiKey).toEqual(binding);
  });

  it("redacts plain binding value for sensitive key", () => {
    const record = { password: { type: "plain", value: "hunter2" } };
    const result = sanitizeRecord(record);
    expect(result.password).toEqual({ type: "plain", value: REDACTED_EVENT_VALUE });
  });

  it("recursively sanitizes nested objects for non-sensitive keys", () => {
    const record = { config: { apiKey: "sk-nested", safe: "ok" } };
    const result = sanitizeRecord(record) as { config: Record<string, unknown> };
    expect(result.config.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.config.safe).toBe("ok");
  });

  it("sanitizes array values recursively", () => {
    const record = { items: [{ apiKey: "sk-1" }, { name: "agent" }] };
    const result = sanitizeRecord(record) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]?.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.items[1]?.name).toBe("agent");
  });

  it("preserves null values", () => {
    const record = { value: null };
    expect(sanitizeRecord(record).value).toBeNull();
  });

  it("is case-insensitive for sensitive key matching", () => {
    const record = { API_KEY: "sk-upper", Password: "pwd" };
    expect(sanitizeRecord(record).API_KEY).toBe(REDACTED_EVENT_VALUE);
    expect(sanitizeRecord(record).Password).toBe(REDACTED_EVENT_VALUE);
  });
});

// ============================================================================
// redactEventPayload
// ============================================================================

describe("redactEventPayload", () => {
  it("returns null for null input", () => {
    expect(redactEventPayload(null)).toBeNull();
  });

  it("sanitizes a plain event payload", () => {
    const payload = { action: "checkout", apiKey: "sk-secret" };
    const result = redactEventPayload(payload)!;
    expect(result.action).toBe("checkout");
    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
  });

  it("returns an empty object unchanged", () => {
    expect(redactEventPayload({})).toEqual({});
  });
});
