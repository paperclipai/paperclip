import { describe, expect, it } from "vitest";
import { sanitizeHttpLogObject, sanitizeSerializedRequestForLog } from "../middleware/logger.js";

describe("http logger redaction", () => {
  it("redacts sensitive headers from serialized requests", () => {
    const sanitized = sanitizeSerializedRequestForLog({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "127.0.0.1:3100",
        authorization: "Bearer super-secret-token",
        cookie: "sid=session-secret",
        "x-openclaw-token": "openclaw-secret",
      },
    }) as Record<string, unknown>;

    const headers = sanitized.headers as Record<string, unknown>;

    expect(headers.host).toBe("127.0.0.1:3100");
    expect(headers.authorization).toBe("***REDACTED***");
    expect(headers.cookie).toBe("***REDACTED***");
    expect(headers["x-openclaw-token"]).toBe("***REDACTED***");
  });

  it("redacts sensitive keys from request props payloads", () => {
    const sanitized = sanitizeHttpLogObject({
      title: "wake issue",
      nested: {
        apiKey: "plain-text-api-key",
        safe: "ok",
      },
      password: "hunter2",
    }) as Record<string, unknown>;

    expect(sanitized).toEqual({
      title: "wake issue",
      nested: {
        apiKey: "***REDACTED***",
        safe: "ok",
      },
      password: "***REDACTED***",
    });
  });
});
