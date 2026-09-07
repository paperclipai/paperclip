import { createServer, request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createHttpLogger } from "../middleware/logger.js";

describe("HTTP logger redaction", () => {
  it("defines the HTTP auth and cookie header paths that must be redacted", () => {
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.cookie");
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain(
      'req.headers["proxy-authorization"]',
    );
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-csrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-xsrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-api-key"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain(
      'req.headers["x-telegram-bot-api-secret-token"]',
    );
    expect(HTTP_LOG_REDACT_PATHS).toContain("reqBody.credentials");
    expect(HTTP_LOG_REDACT_PATHS).toContain("errorContext.details.credentials");
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
            path: "/api/chat-webhooks/endpoint-1/telegram",
            headers: {
              authorization: "Bearer auth-secret",
              cookie: "sid=request-secret",
              "set-cookie": "proxy-secret",
              "x-telegram-bot-api-secret-token":
                "telegram-webhook-canary-534c28",
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
    expect(output).not.toMatch(
      /auth-secret|request-secret|proxy-secret|response-secret|telegram-webhook-canary-534c28/,
    );

    const log = JSON.parse(output.trim()) as {
      req: { headers: Record<string, string> };
      res: { headers: Record<string, string> };
    };
    expect(log.req.headers.authorization).toBe("[Redacted]");
    expect(log.req.headers.cookie).toBe("[Redacted]");
    expect(log.req.headers["set-cookie"]).toBe("[Redacted]");
    expect(log.req.headers["x-telegram-bot-api-secret-token"]).toBe(
      "[Redacted]",
    );
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
    expect(output).not.toMatch(
      new RegExp(`${authorizationCode}|${providerProse}|${providerUriCanary}`),
    );

    const log = JSON.parse(output.trim()) as {
      msg: string;
      req: { method: string; url: string; query?: unknown };
      reqQuery?: unknown;
    };
    expect(log.msg).toBe("GET /api/tools/oauth/callback 400");
    expect(log.req).toMatchObject({
      method: "GET",
      url: "/api/tools/oauth/callback",
    });
    expect(log.req.query).toBeUndefined();
    expect(log.reqQuery).toBeUndefined();
  });

  it("redacts failed secret payload values from structured request logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const testLogger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(testLogger));
    app.post("/api/companies/:companyId/secrets", (_req, res) => {
      res.status(422).json({ error: "validation failed" });
    });

    const response = await request(app)
      .post("/api/companies/company-1/secrets")
      .send({
        name: "OpenAI",
        value: "value-canary-4c845d",
        metadata: { token: "token-canary-902ffc" },
      });

    expect(response.status).toBe(422);
    const output = chunks.join("");
    expect(output).not.toMatch(/value-canary-4c845d|token-canary-902ffc/);

    const log = JSON.parse(output.trim()) as {
      reqBody: Record<string, unknown>;
    };
    expect(log.reqBody).toEqual({
      name: "OpenAI",
      value: "[REDACTED]",
      metadata: { token: "[REDACTED]" },
    });
  });

  it("redacts every credential from serialized chat setup 422 and 500 logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const testLogger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(testLogger));
    const routes = express.Router();
    routes.post("/chat-endpoints/:endpointId/setup", (req, res, next) => {
      const mode = req.header("x-test-mode");
      if (mode === "generic-500") {
        const error = new Error(
          `synthetic provider failure echoed ${req.body.credentials.botToken}`,
        );
        error.name = `SecretName-${req.body.credentials.signingSecret}`;
        next(error);
        return;
      }
      if (mode === "http-500") {
        next(
          new HttpError(
            500,
            `synthetic HTTP failure echoed ${req.body.credentials.webhookSecret}`,
            { credentials: req.body.credentials },
          ),
        );
        return;
      }
      next(
        new HttpError(
          422,
          `synthetic validation failure echoed ${req.body.credentials.privateKey}`,
          { credentials: req.body.credentials },
        ),
      );
    });
    routes.post(
      "/chat-endpoints/:endpointId/setup-secret",
      (req, _res, next) => {
        next(
          new Error(`synthetic rotation failure echoed ${req.body.bot_token}`),
        );
      },
    );
    app.use("/api", routes);
    app.use(errorHandler);

    const credentials = {
      botToken: "bot-token-canary-bf231a",
      signingSecret: "signing-secret-canary-0f861d",
      webhookSecret: "webhook-secret-canary-54c112",
      privateKey: "private-key-canary-26ec43",
      clientSecret: "client-secret-canary-944088",
      arbitraryFutureCredential: "future-credential-canary-5e6941",
    };
    const outsideEnvelope = {
      bot_token: "snake-bot-canary-512c31",
      signing_secret: "snake-signing-canary-efb11f",
      webhook_secret: "snake-webhook-canary-415b14",
      secret_token: "snake-secret-token-canary-3ba19f",
      app_secret: "snake-app-canary-fd29eb",
      application_secret: "snake-application-canary-42bc91",
    };
    const canaries = [
      ...Object.values(credentials),
      ...Object.values(outsideEnvelope),
    ];

    const validationResponse = await request(app)
      .post("/api/chat-endpoints/endpoint-1/setup")
      .send({ action: "configure", credentials, diagnostic: outsideEnvelope });
    const genericCrashResponse = await request(app)
      .post("/api/chat-endpoints/endpoint-1/setup")
      .set("x-test-mode", "generic-500")
      .send({ action: "configure", credentials, diagnostic: outsideEnvelope });
    const httpCrashResponse = await request(app)
      .post("/api/chat-endpoints/endpoint-1/setup")
      .set("x-test-mode", "http-500")
      .send({ action: "configure", credentials, diagnostic: outsideEnvelope });
    const setupSecretCrashResponse = await request(app)
      .post("/api/chat-endpoints/endpoint-1/setup-secret")
      .send({ bot_token: outsideEnvelope.bot_token });

    expect(validationResponse.status).toBe(422);
    expect(genericCrashResponse.status).toBe(500);
    expect(httpCrashResponse.status).toBe(500);
    expect(setupSecretCrashResponse.status).toBe(500);
    for (const response of [
      validationResponse,
      genericCrashResponse,
      httpCrashResponse,
      setupSecretCrashResponse,
    ]) {
      for (const canary of canaries) {
        expect(JSON.stringify(response.body)).not.toContain(canary);
      }
    }
    expect(validationResponse.body).toMatchObject({
      error: "synthetic validation failure echoed [REDACTED]",
      details: { credentials: "[REDACTED]" },
    });
    expect(httpCrashResponse.body).toEqual({ error: "Internal server error" });
    const output = chunks.join("");
    for (const canary of canaries) {
      expect(output).not.toContain(canary);
    }

    const logs = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)) as Array<{
      msg: string;
      res: { statusCode: number };
      req: { url: string };
      reqBody: Record<string, unknown>;
      errorContext?: Record<string, unknown>;
    }>;
    expect(logs).toHaveLength(4);
    const setupLogs = logs.filter((log) => log.req.url.endsWith("/setup"));
    expect(setupLogs).toHaveLength(3);
    for (const log of setupLogs) {
      expect(log.reqBody).toEqual({
        action: "configure",
        credentials: "[Redacted]",
        diagnostic: Object.fromEntries(
          Object.keys(outsideEnvelope).map((key) => [key, "[REDACTED]"]),
        ),
      });
    }
    const crashLogs = logs.filter((log) => log.res.statusCode === 500);
    expect(crashLogs).toHaveLength(3);
    for (const log of crashLogs) {
      expect(log.msg).toMatch(/ 500 — request failed$/);
      expect(log.errorContext).toEqual({ name: "Error" });
    }
    expect(
      logs.find((log) => log.req.url.endsWith("/setup-secret"))?.reqBody,
    ).toEqual({
      bot_token: "[REDACTED]",
    });
  });
});
