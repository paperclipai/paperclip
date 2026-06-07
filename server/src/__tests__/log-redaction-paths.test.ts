import { describe, expect, it } from "vitest";
import pino from "pino";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/log-redaction-paths.js";

/**
 * Logs `value` through a pino instance configured with the production redact
 * paths and returns both the parsed record and the raw serialized line, so we
 * can assert structurally AND that no sensitive substring survives anywhere.
 */
function logWithRedaction(value: unknown): { record: any; raw: string } {
  const lines: string[] = [];
  const logger = pino(
    { redact: [...HTTP_LOG_REDACT_PATHS] },
    { write: (line: string) => lines.push(line) } as any,
  );
  logger.info(value as any);
  const raw = lines.join("");
  return { record: JSON.parse(raw), raw };
}

describe("HTTP_LOG_REDACT_PATHS (SOF-100)", () => {
  it("redacts cookie, authorization, and CSRF headers on request logs", () => {
    const { record } = logWithRedaction({
      req: {
        method: "GET",
        url: "/api/test",
        headers: {
          authorization: "Bearer super-secret-token",
          cookie: "paperclip_session=top-secret-session-value; other=1",
          "x-csrf-token": "csrf-secret-value",
          "x-xsrf-token": "xsrf-secret-value",
          "x-api-key": "api-key-secret-value",
          "user-agent": "vitest",
        },
      },
    });

    expect(record.req.headers.cookie).toBe("[Redacted]");
    expect(record.req.headers.authorization).toBe("[Redacted]");
    expect(record.req.headers["x-csrf-token"]).toBe("[Redacted]");
    expect(record.req.headers["x-xsrf-token"]).toBe("[Redacted]");
    expect(record.req.headers["x-api-key"]).toBe("[Redacted]");
    // Non-sensitive headers are preserved for debuggability.
    expect(record.req.headers["user-agent"]).toBe("vitest");
  });

  it("never serializes the raw cookie/session value anywhere in the line", () => {
    const secret = "top-secret-session-value";
    const { raw } = logWithRedaction({
      req: { headers: { cookie: `paperclip_session=${secret}` } },
    });
    expect(raw).not.toContain(secret);
  });

  it("redacts sensitive headers even without the req envelope", () => {
    const { record } = logWithRedaction({
      headers: {
        cookie: "session=another-secret",
        authorization: "Bearer another-token",
        "set-cookie": "session=set-cookie-secret",
        "proxy-authorization": "Basic proxy-secret",
        "x-csrf-token": "bare-csrf-secret",
        "x-xsrf-token": "bare-xsrf-secret",
        "x-api-key": "bare-api-key-secret",
      },
    });
    expect(record.headers.cookie).toBe("[Redacted]");
    expect(record.headers.authorization).toBe("[Redacted]");
    expect(record.headers["set-cookie"]).toBe("[Redacted]");
    expect(record.headers["proxy-authorization"]).toBe("[Redacted]");
    expect(record.headers["x-csrf-token"]).toBe("[Redacted]");
    expect(record.headers["x-xsrf-token"]).toBe("[Redacted]");
    expect(record.headers["x-api-key"]).toBe("[Redacted]");
  });
});
