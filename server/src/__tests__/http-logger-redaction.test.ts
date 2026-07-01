import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

import { HTTP_LOG_REDACT_PATHS } from "../middleware/logger.js";

/**
 * Regression test for KSI-641: redact session cookies from server.log.
 *
 * The server emits HTTP logs through pino-http, which inherits the redact
 * config of the base logger declared in `server/src/middleware/logger.ts`.
 * Better-Auth issues session tokens as request `Cookie` headers and response
 * `Set-Cookie` headers; both must never be written to disk in plaintext.
 *
 * Strategy:
 *
 * 1. Asserção estrutural — `HTTP_LOG_REDACT_PATHS` cobre `cookie`,
 *    `set-cookie` e mantém `authorization` (proteção pré-existente).
 * 2. Asserção funcional — instanciar um pino real com a constante apontando
 *    para um buffer e logar um payload sintético equivalente ao que pino-http
 *    serializa. O JSON resultante NÃO pode conter o valor do token.
 */

describe("HTTP logger redact configuration", () => {
  it("includes the session-cookie request and response headers plus authorization", () => {
    expect(HTTP_LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ]),
    );
  });
});

describe("HTTP logger redaction at runtime", () => {
  function captureLog(payload: unknown): string {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    const localLogger = pino(
      { level: "info", redact: HTTP_LOG_REDACT_PATHS },
      sink,
    );
    localLogger.info(payload as Record<string, unknown>, "request");
    return Buffer.concat(chunks).toString("utf8");
  }

  it("redacts the session cookie value from the request Cookie header", () => {
    const cookieValue =
      "paperclip-ksio-dev.session_token=ABC.DEF.GHI; other=keep";
    const output = captureLog({
      req: {
        method: "GET",
        url: "/api/agents/me",
        headers: {
          cookie: cookieValue,
          authorization: "Bearer secret-bearer-token",
          "user-agent": "vitest",
        },
      },
      res: {
        statusCode: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    });

    // pino's default redact replacement is "[Redacted]" (mixed case) and it
    // preserves the field key — only the value is rewritten.
    expect(output).toContain('"cookie":"[Redacted]"');
    expect(output).toContain('"authorization":"[Redacted]"');

    // The actual token value (and any substring of it) must not survive.
    expect(output).not.toContain("ABC.DEF.GHI");
    expect(output).not.toContain("session_token=ABC");
    expect(output).not.toContain("secret-bearer-token");

    // Non-sensitive headers stay intact for debugging.
    expect(output).toContain('"user-agent":"vitest"');
    expect(output).toContain('"method":"GET"');
    expect(output).toContain('"url":"/api/agents/me"');
  });

  it("redacts Set-Cookie response headers (array form, as Node sets them)", () => {
    const setCookieValue = [
      "paperclip-ksio-dev.session_token=ZZZ.WWW.YYY; Path=/; HttpOnly",
      "paperclip-ksio-dev.session_data=opaque-data; Path=/; HttpOnly",
    ];
    const output = captureLog({
      req: {
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "user-agent": "vitest" },
      },
      res: {
        statusCode: 200,
        headers: {
          "set-cookie": setCookieValue,
          "content-type": "application/json",
        },
      },
    });

    expect(output).toContain('"set-cookie":"[Redacted]"');
    expect(output).not.toContain("ZZZ.WWW.YYY");
    expect(output).not.toContain("session_token=ZZZ");
    expect(output).not.toContain("opaque-data");

    // The neighboring response header survives so we can still see status/body
    // shape from the log.
    expect(output).toContain('"content-type":"application/json"');
  });

  it("does not over-redact: only the configured paths are rewritten", () => {
    const output = captureLog({
      req: {
        method: "GET",
        url: "/api/issues/KSI-641",
        headers: {
          "x-paperclip-run-id": "run-42",
          "content-type": "application/json",
        },
      },
      res: {
        statusCode: 200,
        headers: {
          "content-type": "application/json",
          "x-trace-id": "trace-abc",
        },
      },
    });

    // No redaction marker should appear when no sensitive fields are present.
    expect(output).not.toContain("[Redacted]");
    expect(output).toContain('"x-paperclip-run-id":"run-42"');
    expect(output).toContain('"x-trace-id":"trace-abc"');
  });
});
