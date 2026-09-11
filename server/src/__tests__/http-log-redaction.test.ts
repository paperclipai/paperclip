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
import { testAdapterEnvironmentSchema } from "@paperclipai/shared";
import { createHttpLogger } from "../middleware/logger.js";

describe("HTTP logger redaction", () => {
  it.each([
    {
      method: "POST",
      path: "http://provider.invalid/api/chat-webhooks/../private-url-canary",
    },
    { method: "GET", path: "/api/chat-webhooks/private-url-canary/slack/" },
    { method: "PUT", path: "/API/CHAT-WEBHOOKS/private-url-canary/SLACK" },
    { method: "PATCH", path: "/api/chat-webhooks//private-url-canary" },
    { method: "DELETE", path: "/api/chat-webhooks/private-url-canary/%XX" },
    {
      method: "POST",
      path: "/api/chat-webhooks/private-url-canary/slack/extra",
    },
    { method: "POST", path: "/api/chat-webhooks?payload=private-url-canary" },
    {
      method: "POST",
      path: "http://provider.invalid/api/chat-webhooks/private-url-canary/slack?token=private-url-canary",
    },
  ])(
    "keeps malformed/rejected webhook $method requests content-free",
    async ({ method, path }) => {
      const privateText = "private-rejected-method-body-canary";
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = express();
      app.use(
        createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
      );
      app.use(express.raw({ type: "*/*" }));
      app.use((_req, res) => {
        (res as any).err = new Error(`SDK error echoed ${privateText}`);
        res.setHeader("x-provider-prose", privateText);
        res.status(405).end();
      });
      const server = createServer(app);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Fixture listener unavailable");
        const body = JSON.stringify({ text: privateText });
        await new Promise<void>((resolve, reject) => {
          const client = httpRequest(
            {
              hostname: "127.0.0.1",
              port: address.port,
              method,
              path,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                "x-provider-prose": privateText,
              },
            },
            (res) => {
              expect(res.statusCode).toBe(405);
              res.resume();
              res.on("end", resolve);
            },
          );
          client.on("error", reject);
          client.end(body);
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      const output = chunks.join("");
      expect(output).not.toContain(privateText);
      expect(output).not.toContain("private-url-canary");
      expect(output).not.toContain("provider.invalid");
      const log = JSON.parse(output.trim());
      expect(log.req).toMatchObject({
        method,
        url: "/api/chat-webhooks/:publicId/:provider",
      });
      expect(log.reqBody).toBe("[REDACTED]");
      expect(log.err.message).toBe("Chat webhook request failed");
      expect(log.res).toEqual({ statusCode: 405 });
      expect(log.responseTime).toEqual(expect.any(Number));
    },
  );

  it.each(
    ["raw-json", "raw-form", "raw-text", "parsed-json", "parsed-form"].flatMap(
      (bodyKind) =>
        ["warning", "context-error", "bare-sdk-error"].flatMap((failureMode) =>
          [false, true].map((mountedLogger) => ({
            bodyKind,
            failureMode,
            mountedLogger,
          })),
        ),
    ),
  )(
    "omits private webhook input: $bodyKind / $failureMode / mounted=$mountedLogger",
    async ({ bodyKind, failureMode, mountedLogger }) => {
      const canaries = {
        text: "private-chat-text-canary-9024",
        filename: "private-file-name-canary-7731.txt",
        token: "private-webhook-token-canary-2342",
        sdk: "private-sdk-prose-canary-1148",
      };
      const payload = {
        text: canaries.text,
        files: [{ name: canaries.filename }],
        token: canaries.token,
      };
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const testLogger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
      const app = express();
      const routes = express.Router();
      if (mountedLogger) routes.use(createHttpLogger(testLogger));
      else app.use(createHttpLogger(testLogger));
      routes.use(
        bodyKind === "parsed-json"
          ? express.json()
          : bodyKind === "parsed-form"
            ? express.urlencoded({ extended: false })
            : bodyKind === "raw-text"
              ? express.text({ type: "*/*" })
              : express.raw({ type: "*/*" }),
      );
      routes.post("/chat-webhooks/:publicId/:provider", (req, res) => {
        res.setHeader("x-provider-diagnostic", canaries.sdk);
        const sdkError = Object.assign(
          new Error(`${canaries.sdk}: ${canaries.text} ${canaries.token}`),
          {
            name: canaries.filename,
            request: { body: req.body },
            response: { data: canaries.text },
          },
        );
        if (failureMode === "context-error") {
          (res as any).__errorContext = {
            error: {
              message: sdkError.message,
              stack: sdkError.stack,
              name: sdkError.name,
              raw: sdkError,
            },
            reqBody: req.body,
            reqParams: { ...req.params, private: canaries.filename },
            reqQuery: { text: canaries.text },
          };
        }
        if (failureMode !== "warning") (res as any).err = sdkError;
        res.status(failureMode === "warning" ? 401 : 503).end();
      });
      app.use("/api", routes);
      const contentType = bodyKind.includes("form")
        ? "application/x-www-form-urlencoded"
        : bodyKind === "raw-text"
          ? "text/plain"
          : "application/json";
      const wireBody = bodyKind.includes("form")
        ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
        : JSON.stringify(payload);
      const response = await request(app)
        .post("/api/chat-webhooks/endpoint-1/slack")
        .set("Content-Type", contentType)
        .send(wireBody);
      expect(response.status).toBe(failureMode === "warning" ? 401 : 503);
      const output = chunks.join("");
      const log = JSON.parse(output.trim());
      // Structural absence catches Buffer's numeric-byte representation too;
      // matching plaintext canaries alone would miss that encoding of the body.
      expect(log.reqBody).toBe("[REDACTED]");
      expect(log.reqParams).toBeUndefined();
      expect(log.req.body).toBeUndefined();
      expect(log.req.params).toBeUndefined();
      expect(log.req.query).toBeUndefined();
      expect(log.req.method).toBe("POST");
      expect(log.res.statusCode).toBe(response.status);
      expect(log.res.headers).toBeUndefined();
      expect(log.responseTime).toEqual(expect.any(Number));
      expect(log.level).toBe(failureMode === "warning" ? 40 : 50);
      for (const canary of Object.values(canaries))
        expect(output).not.toContain(canary);
      if (failureMode !== "warning") {
        expect(log.msg).toMatch(/503 — request failed$/);
        expect(log.err.message).toBe("Chat webhook request failed");
        expect(log.err.request).toBeUndefined();
        expect(log.errorContext).toEqual({ name: "Error" });
      }
    },
  );

  it.each(["slack", "github", "discord", "telegram", "microsoft-teams"])(
    "keeps %s webhook request serialization and error-handler SDK prose content-free",
    async (provider) => {
      const privateText = "private-serialized-webhook-text-canary-8124";
      const privateFile = "private-serialized-webhook-file-canary-2443.png";
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = express();
      const routes = express.Router();
      routes.use(express.raw({ type: "*/*" }));
      routes.use(
        createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
      );
      routes.post("/chat-webhooks/:publicId/:provider", (req, _res, next) => {
        req.params.extra = privateFile;
        req.log.warn({ req }, "Webhook fixture rejected");
        const error = Object.assign(new Error(`SDK echoed ${privateText}`), {
          name: privateFile,
        });
        next(error);
      });
      app.use("/api", routes);
      app.use(errorHandler);
      const response = await request(app)
        .post(`/api/chat-webhooks/endpoint-1/${provider}`)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ text: privateText, file: privateFile }));
      expect(response.status).toBe(500);
      const output = chunks.join("");
      expect(output).not.toContain(privateText);
      expect(output).not.toContain(privateFile);
      const logs = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(logs).toHaveLength(2);
      for (const log of logs) {
        expect(log.req.method).toBe("POST");
        expect(log.req.params).toBeUndefined();
        expect(log.req.body).toBeUndefined();
      }
      expect(logs[1].res.statusCode).toBe(500);
      expect(logs[1].reqBody).toBe("[REDACTED]");
      expect(logs[1].errorContext).toEqual({ name: "Error" });
      expect(logs[1].err.message).toBe("Chat webhook request failed");
    },
  );

  it("preserves ordinary request diagnostics outside the exact webhook route", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = express();
    app.use(express.json());
    app.use(
      createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
    );
    app.post("/api/issues/:id", (req, res) => {
      (res as any).__errorContext = {
        error: { name: "Error", message: "ordinary diagnostic" },
        reqBody: req.body,
        reqParams: req.params,
      };
      res.status(422).end();
    });
    await request(app)
      .post("/api/issues/issue-1")
      .send({ title: "ordinary task", token: "redact-me" });
    const log = JSON.parse(chunks.join("").trim());
    expect(log.reqBody).toEqual({
      title: "ordinary task",
      token: "[REDACTED]",
    });
    expect(log.reqParams).toEqual({ id: "issue-1" });
    expect(log.errorContext).toEqual({
      name: "Error",
      message: "ordinary diagnostic",
    });
  });

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

  it.each([400, 500])(
    "redacts the complete probe credential container on HTTP %s",
    async (status) => {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = express();
      app.use(express.json());
      app.use(
        createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
      );
      app.post("/probe", (req, res) => {
        if (status === 500) {
          (res as any).__errorContext = {
            error: { message: "probe failed" },
            reqBody: req.body,
          };
        }
        res.status(status).json({ error: "probe failed" });
      });
      const keys = Object.keys(
        testAdapterEnvironmentSchema.shape.testCredentials.unwrap().shape,
      );
      const credentials = Object.fromEntries(
        [...keys, "UNKNOWN_PROVIDER_KEY"].map((key) => [key, `canary-${key}`]),
      );
      await request(app)
        .post("/probe")
        .send({
          adapterConfig: { model: "default" },
          testCredentials: credentials,
        });
      const output = chunks.join("");
      expect(output).not.toContain("canary-");
      expect(JSON.parse(output.trim()).reqBody).toEqual({
        adapterConfig: { model: "default" },
        testCredentials: "[REDACTED]",
      });
    },
  );
});
