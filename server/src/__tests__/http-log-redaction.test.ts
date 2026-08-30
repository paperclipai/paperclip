import { createServer, request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";

describe("HTTP logger redaction", () => {
  it("defines the HTTP auth and cookie header paths that must be redacted", () => {
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.cookie");
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["proxy-authorization"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-csrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-xsrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-api-key"]');
  });

  it("redacts request and response header secrets from pino-http output", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
    const httpLogger = pinoHttp({ logger });
    const server = createServer((req, res) => {
      httpLogger(req, res);
      res.setHeader("set-cookie", "sid=response-secret");
      res.end("ok");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server to listen on an ephemeral TCP port");
      }

      await new Promise<void>((resolve, reject) => {
        const client = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/redaction-check",
            headers: {
              authorization: "Bearer auth-secret",
              cookie: "sid=request-secret",
              "set-cookie": "proxy-secret",
            },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end();
      });

      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    expect(output).not.toMatch(/auth-secret|request-secret|proxy-secret|response-secret/);

    const log = JSON.parse(output.trim()) as {
      req: { headers: Record<string, string> };
      res: { headers: Record<string, string> };
    };
    expect(log.req.headers.authorization).toBe("[Redacted]");
    expect(log.req.headers.cookie).toBe("[Redacted]");
    expect(log.req.headers["set-cookie"]).toBe("[Redacted]");
    expect(log.res.headers["set-cookie"]).toBe("[Redacted]");
  });

  it("drops OAuth callback query data from the message and structured request", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const testLogger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
    const app = express();
    app.use(createHttpLogger(testLogger));
    app.get("/api/tools/oauth/callback", (_req, res) => {
      res.status(400).json({ error: "callback rejected" });
    });

    const authorizationCode = "oauth-code-canary-61a88f";
    const providerProse = "provider-prose-canary-2087e2";
    const providerUriCanary = "provider-uri-canary-d91ac4";
    const response = await request(app)
      .get("/api/tools/oauth/callback")
      .query({
        code: authorizationCode,
        error_description: providerProse,
        error_uri: `https://provider.example/error?detail=${providerUriCanary}`,
      });

    expect(response.status).toBe(400);
    const output = chunks.join("");
    expect(output).not.toMatch(new RegExp(`${authorizationCode}|${providerProse}|${providerUriCanary}`));

    const log = JSON.parse(output.trim()) as {
      msg: string;
      req: { method: string; url: string; query?: unknown };
      reqQuery?: unknown;
    };
    expect(log.msg).toBe("GET /api/tools/oauth/callback 400");
    expect(log.req).toMatchObject({ method: "GET", url: "/api/tools/oauth/callback" });
    expect(log.req.query).toBeUndefined();
    expect(log.reqQuery).toBeUndefined();
  });
});
