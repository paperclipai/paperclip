/**
 * Integration tests for httpLoggerCustomProps — the function passed to pino-http
 * as `customProps`. Tests exercise the real call site in middleware/logger.ts so
 * they FAIL if sanitizeRecord() calls are removed from that file.
 *
 * Do NOT import sanitizeRecord directly here; that would make the tests vacuous
 * (they'd pass even if logger.ts never called sanitizeRecord).
 */
import { describe, expect, it } from "vitest";
import { httpLoggerCustomProps } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

function makeReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: "POST", url: "/api/auth/sign-in/email", ...overrides };
}

function makeRes(statusCode: number, errorContext?: Record<string, unknown>): Record<string, unknown> {
  const res: Record<string, unknown> = { statusCode };
  if (errorContext) res.__errorContext = errorContext;
  return res;
}

describe("httpLoggerCustomProps — req.body path", () => {
  it("redacts password from sign-in body on 4xx", () => {
    const req = makeReq({ body: { email: "user@example.com", password: "hunter2" } });
    const res = makeRes(401);

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqBody as any).password).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqBody as any).email).toBe("user@example.com");
  });

  it("redacts currentPassword and newPassword from change-password body on 4xx", () => {
    const req = makeReq({ body: { currentPassword: "old-pass", newPassword: "new-pass", userId: "u-1" } });
    const res = makeRes(400);

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqBody as any).currentPassword).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqBody as any).newPassword).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqBody as any).userId).toBe("u-1");
  });

  it("redacts token from query params on 4xx (reset-password link pattern)", () => {
    const req = makeReq({ query: { token: "reset-abc123xyz", redirect: "/dashboard" } });
    const res = makeRes(403);

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqQuery as any).token).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqQuery as any).redirect).toBe("/dashboard");
  });

  it("redacts apiKey from URL path params on 4xx", () => {
    const req = makeReq({ params: { apiKey: "sk-secret", instanceId: "inst-001" } });
    const res = makeRes(404);

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqParams as any).apiKey).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqParams as any).instanceId).toBe("inst-001");
  });

  it("returns empty object for 2xx responses (no credential fields logged)", () => {
    const req = makeReq({ body: { password: "hunter2" } });
    const res = makeRes(200);

    const props = httpLoggerCustomProps(req, res);

    expect(props).toEqual({});
  });
});

describe("httpLoggerCustomProps — __errorContext path", () => {
  it("redacts password in errorContext.reqBody on 4xx", () => {
    const req = makeReq();
    const res = makeRes(401, {
      error: { message: "Invalid credentials" },
      reqBody: { email: "user@example.com", password: "hunter2" },
      reqParams: {},
      reqQuery: {},
    });

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqBody as any).password).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqBody as any).email).toBe("user@example.com");
  });

  it("redacts token in errorContext.reqQuery on 4xx", () => {
    const req = makeReq();
    const res = makeRes(400, {
      error: { message: "Bad request" },
      reqBody: {},
      reqQuery: { token: "reset-abc123xyz", continue: "/home" },
      reqParams: {},
    });

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqQuery as any).token).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqQuery as any).continue).toBe("/home");
  });

  it("redacts secret in errorContext.reqParams on 4xx", () => {
    const req = makeReq();
    const res = makeRes(422, {
      error: { message: "Unprocessable" },
      reqBody: {},
      reqQuery: {},
      reqParams: { secret: "shared-secret-value", orgId: "org-001" },
    });

    const props = httpLoggerCustomProps(req, res);

    expect((props.reqParams as any).secret).toBe(REDACTED_EVENT_VALUE);
    expect((props.reqParams as any).orgId).toBe("org-001");
  });
});
