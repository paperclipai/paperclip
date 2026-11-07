import { IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  HTTP_LOG_REDACT_PATHS,
  redactCredentialFields,
  sanitizeCredentialText,
  sanitizeErrorObject,
} from "../middleware/http-log-redaction.js";
import { errorHandler } from "../middleware/error-handler.js";
import { basePinoOptions, createHttpLogger } from "../middleware/logger.js";

describe("Tool gateway credential redaction", () => {
  const SESSION_TOKEN =
    "pcgt_11111111-2222-3333-4444-555555555555.c2Vzc2lvbi1zZW50aW5lbC1vbmU";
  const GATEWAY_TOKEN =
    "pcgw_66666666-7777-8888-9999-000000000000.Z2F0ZXdheS1zZW50aW5lbC10d28";
  const BEARER_SENTINEL = "bearer-sentinel-3f9c17ab";
  const CAPABILITY_SENTINEL = "capability-sentinel-84d0";
  const RUN_ID = "run-diagnostic-6f2a";
  const CLIENT_NAME = "cursor-diagnostic-client";

  function captureChunks(chunks: string[]) {
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
  }

  function productionLogger(chunks: string[]) {
    return pino(basePinoOptions, captureChunks(chunks));
  }

  function logRecords(chunks: string[]): any[] {
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  it("redacts the gateway token header and fields by path, without duplicate paths", () => {
    expect(new Set(HTTP_LOG_REDACT_PATHS).size).toBe(
      HTTP_LOG_REDACT_PATHS.length,
    );
    expect(HTTP_LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers["x-paperclip-tool-gateway-token"]',
        'res.headers["x-paperclip-tool-gateway-token"]',
        '["x-paperclip-tool-gateway-token"]',
        "req.headers.authorization",
        "res.headers.authorization",
        "authorization",
        "gatewayToken",
        "sessionToken",
      ]),
    );
    expect(basePinoOptions.redact.paths).toEqual([...HTTP_LOG_REDACT_PATHS]);
  });

  it("redacts gateway credentials from a successful request log and keeps safe diagnostics", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(productionLogger(chunks)));
    app.post("/api/tool-gateway/tools/call", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const response = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("Authorization", `Bearer ${BEARER_SENTINEL}`)
      .set("X-Paperclip-Tool-Gateway-Token", GATEWAY_TOKEN)
      .set("X-Paperclip-Github-Capability", CAPABILITY_SENTINEL)
      .set("X-Paperclip-Run-Id", RUN_ID)
      .set("X-Paperclip-Client-Name", CLIENT_NAME)
      .send({ tool: "calculator:add" });

    expect(response.status).toBe(200);
    const output = chunks.join("");
    expect(output).not.toContain(BEARER_SENTINEL);
    expect(output).not.toContain(GATEWAY_TOKEN);
    expect(output).not.toContain(CAPABILITY_SENTINEL);

    const [log] = logRecords(chunks);
    expect(log.msg).toBe("POST /api/tool-gateway/tools/call 200");
    expect(log.res.statusCode).toBe(200);
    expect(log.req.headers.authorization).toBe("[Redacted]");
    expect(log.req.headers["x-paperclip-tool-gateway-token"]).toBe(
      "[Redacted]",
    );
    expect(log.req.headers["x-paperclip-github-capability"]).toBe("[Redacted]");
    expect(log.req.headers["x-paperclip-run-id"]).toBe(RUN_ID);
    expect(log.req.headers["x-paperclip-client-name"]).toBe(CLIENT_NAME);
  });

  it("redacts credential-bearing response headers while keeping safe response headers", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(productionLogger(chunks)));
    app.get("/api/tool-gateway/session", (_req, res) => {
      res.setHeader("x-paperclip-tool-gateway-token", GATEWAY_TOKEN);
      res.setHeader("x-paperclip-signature", `sha256=${CAPABILITY_SENTINEL}`);
      res.setHeader("x-paperclip-bridge-outcome", "accepted");
      res.status(200).json({ ok: true });
    });

    await request(app).get("/api/tool-gateway/session").expect(200);

    const output = chunks.join("");
    expect(output).not.toContain(GATEWAY_TOKEN);
    expect(output).not.toContain(CAPABILITY_SENTINEL);

    const [log] = logRecords(chunks);
    expect(log.res.headers["x-paperclip-tool-gateway-token"]).toBe(
      "[Redacted]",
    );
    expect(log.res.headers["x-paperclip-signature"]).toBe("[Redacted]");
    expect(log.res.headers["x-paperclip-bridge-outcome"]).toBe("accepted");
  });

  it("redacts unlisted credential-shaped headers on both sides of a request", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(productionLogger(chunks)));
    app.get("/api/tool-gateway/session", (_req, res) => {
      res.setHeader("x-acme-connector-secret", `response-${CAPABILITY_SENTINEL}`);
      res.setHeader("x-paperclip-bridge-outcome", "accepted");
      res.status(200).json({ ok: true });
    });

    await request(app)
      .get("/api/tool-gateway/session")
      .set("X-Acme-Connector-Secret", `request-${CAPABILITY_SENTINEL}`)
      .set("X-Paperclip-Run-Id", RUN_ID)
      .expect(200);

    const output = chunks.join("");
    expect(output).not.toContain(`request-${CAPABILITY_SENTINEL}`);
    expect(output).not.toContain(`response-${CAPABILITY_SENTINEL}`);

    const [log] = logRecords(chunks);
    expect(log.req.headers["x-acme-connector-secret"]).toBe("[Redacted]");
    expect(log.res.headers["x-acme-connector-secret"]).toBe("[Redacted]");
    expect(log.req.headers["x-paperclip-run-id"]).toBe(RUN_ID);
    expect(log.res.headers["x-paperclip-bridge-outcome"]).toBe("accepted");
  });

  it("redacts a rejected session token from the 401 log and the error response", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(productionLogger(chunks)));
    app.post("/api/tool-gateway/tools", (req, _res, next) => {
      next(
        new HttpError(
          401,
          `Invalid tool gateway session token: ${req.header("x-paperclip-tool-gateway-token")}`,
          { reasonCode: "invalid_token", phase: "authenticate" },
        ),
      );
    });
    app.use(errorHandler);

    const response = await request(app)
      .post("/api/tool-gateway/tools")
      .set("X-Paperclip-Tool-Gateway-Token", SESSION_TOKEN)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(response.status).toBe(401);
    expect(response.body.details).toEqual({
      reasonCode: "invalid_token",
      phase: "authenticate",
    });

    const output = chunks.join("");
    expect(output).not.toContain(SESSION_TOKEN);

    const [log] = logRecords(chunks);
    expect(log.req.headers["x-paperclip-tool-gateway-token"]).toBe(
      "[Redacted]",
    );
    expect(log.req.headers["x-paperclip-run-id"]).toBe(RUN_ID);
    expect(log.res.statusCode).toBe(401);
  });

  it("redacts echoed gateway credentials from a downstream 502 message, context, and error", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(productionLogger(chunks)));
    app.post("/api/tool-gateway/tools/call", (_req, _res, next) => {
      next(
        new HttpError(
          502,
          `Downstream MCP call failed for ${GATEWAY_TOKEN}`,
          {
            reasonCode: "downstream_failed",
            phase: "invoke",
            mechanism: "streamable_http",
          },
        ),
      );
    });
    app.use(errorHandler);

    const response = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("Authorization", `Bearer ${BEARER_SENTINEL}`)
      .send({ tool: "weather:forecast" });

    expect(response.status).toBe(502);

    const output = chunks.join("");
    expect(output).not.toContain(GATEWAY_TOKEN);
    expect(output).not.toContain(BEARER_SENTINEL);

    const [log] = logRecords(chunks);
    expect(log.msg).toBe(
      "POST /api/tool-gateway/tools/call 502 — Downstream MCP call failed for [REDACTED]",
    );
    expect(log.errorContext.message).toBe(
      "Downstream MCP call failed for [REDACTED]",
    );
    expect(log.errorContext.details).toEqual({
      reasonCode: "downstream_failed",
      phase: "invoke",
      mechanism: "streamable_http",
    });
    expect(log.err.type).toBe("HttpError");
    expect(log.err.message).toBe("Downstream MCP call failed for [REDACTED]");
    expect(log.err.stack).not.toContain(GATEWAY_TOKEN);
  });

  it("redacts gateway credentials from an uncaught 500 error message and stack", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(productionLogger(chunks)));
    app.post("/api/tool-gateway/crash", () => {
      throw new Error(
        `Unexpected crash resolving ${SESSION_TOKEN} with Authorization: Bearer ${BEARER_SENTINEL}`,
      );
    });
    app.use(errorHandler);

    await request(app)
      .post("/api/tool-gateway/crash")
      .send({ data: "crash-test" })
      .expect(500);

    const output = chunks.join("");
    expect(output).not.toContain(SESSION_TOKEN);
    expect(output).not.toContain(BEARER_SENTINEL);

    const [log] = logRecords(chunks);
    expect(log.msg).toBe(
      "POST /api/tool-gateway/crash 500 — Unexpected crash resolving [REDACTED] with Authorization: Bearer [REDACTED]",
    );
    expect(log.errorContext.message).toBe(
      "Unexpected crash resolving [REDACTED] with Authorization: Bearer [REDACTED]",
    );
    expect(log.errorContext.stack).not.toContain(SESSION_TOKEN);
    expect(log.err.message).toBe(
      "Unexpected crash resolving [REDACTED] with Authorization: Bearer [REDACTED]",
    );
    expect(log.err.stack).not.toContain(SESSION_TOKEN);
  });

  it("keeps the serialized error's cause chain while redacting credentials from it", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    log.error(
      {
        err: new Error("gateway call failed", {
          cause: new Error(
            `upstream rejected ${GATEWAY_TOKEN} for connector acme-crm`,
          ),
        }),
      },
      "tool gateway invocation failed",
    );

    const output = chunks.join("");
    expect(output).not.toContain(GATEWAY_TOKEN);

    const [record] = logRecords(chunks);
    expect(record.err.type).toBe("Error");
    expect(record.err.message).toBe(
      "gateway call failed: upstream rejected [REDACTED] for connector acme-crm",
    );
    expect(record.err.stack).toContain("caused by");
    expect(record.err.stack).toContain("connector acme-crm");
  });

  it("redacts gateway credentials from child-logger bindings, fields, and messages", () => {
    const chunks: string[] = [];
    const root = productionLogger(chunks);

    const child = root.child({
      service: "tool-gateway",
      gatewayToken: GATEWAY_TOKEN,
      "x-paperclip-tool-gateway-token": SESSION_TOKEN,
      headers: {
        authorization: `Bearer ${BEARER_SENTINEL}`,
        "x-paperclip-run-id": RUN_ID,
      },
    });

    child.info(
      { sessionToken: SESSION_TOKEN, phase: "invoke" },
      `calling gateway with Authorization: Bearer ${BEARER_SENTINEL}`,
    );
    child.error(
      { err: new Error(`connection failed for ${GATEWAY_TOKEN}`) },
      "downstream failure",
    );

    const output = chunks.join("");
    expect(output).not.toContain(GATEWAY_TOKEN);
    expect(output).not.toContain(SESSION_TOKEN);
    expect(output).not.toContain(BEARER_SENTINEL);

    const [infoRecord, errorRecord] = logRecords(chunks);
    expect(infoRecord.service).toBe("tool-gateway");
    expect(infoRecord.gatewayToken).toBe("[Redacted]");
    expect(infoRecord["x-paperclip-tool-gateway-token"]).toBe("[Redacted]");
    expect(infoRecord.headers.authorization).toBe("[Redacted]");
    expect(infoRecord.headers["x-paperclip-run-id"]).toBe(RUN_ID);
    expect(infoRecord.sessionToken).toBe("[Redacted]");
    expect(infoRecord.phase).toBe("invoke");
    expect(infoRecord.msg).toBe(
      "calling gateway with Authorization: Bearer [REDACTED]",
    );
    expect(errorRecord.err.message).toBe("connection failed for [REDACTED]");
  });

  it.each(["child", "grandchild", "setBindings"] as const)(
    "redacts nested credentials from %s bindings without losing safe context",
    (bindingKind) => {
      const chunks: string[] = [];
      const root = productionLogger(chunks);
      const bindings = {
        context: {
          gatewayToken: GATEWAY_TOKEN,
          nested: [{ "X-Paperclip-Tool-Gateway-Token": SESSION_TOKEN }],
          runId: RUN_ID,
        },
      };
      const child = bindingKind === "grandchild"
        ? root.child({ service: "tool-gateway" }).child(bindings)
        : bindingKind === "child"
          ? root.child(bindings)
          : root.child({ service: "tool-gateway" });
      if (bindingKind === "setBindings") child.setBindings(bindings);

      child.info({ phase: "invoke" }, "gateway invocation");

      expect(chunks.join("")).not.toContain(GATEWAY_TOKEN);
      expect(chunks.join("")).not.toContain(SESSION_TOKEN);
      const [record] = logRecords(chunks);
      expect(record.context).toEqual({
        gatewayToken: "[Redacted]",
        nested: [{ "X-Paperclip-Tool-Gateway-Token": "[Redacted]" }],
        runId: RUN_ID,
      });
      expect(record.phase).toBe("invoke");
      expect(bindings.context.gatewayToken).toBe(GATEWAY_TOKEN);
    },
  );

  it.each(["record", "child"] as const)(
    "redacts %s subtrees beyond the inspection limit",
    (source) => {
      const chunks: string[] = [];
      const root = productionLogger(chunks);
      const fields = {
        phase: "invoke",
        context: { a: { b: { c: { d: { e: { gatewayToken: GATEWAY_TOKEN } } } } } },
      };

      if (source === "child") root.child(fields).info("gateway invocation");
      else root.info(fields, "gateway invocation");

      expect(chunks.join("")).not.toContain(GATEWAY_TOKEN);
      const [record] = logRecords(chunks);
      expect(record.context.a.b.c.d.e).toBe("[Redacted]");
      expect(record.phase).toBe("invoke");
      expect(fields.context.a.b.c.d.e.gatewayToken).toBe(GATEWAY_TOKEN);
    },
  );

  it("replaces malformed child output with a content-free diagnostic", () => {
    const chunks: string[] = [];
    const child = productionLogger(chunks).child({ 'invalid"key': GATEWAY_TOKEN });

    expect(() => child.info("gateway invocation")).not.toThrow();

    expect(chunks.join("")).not.toContain(GATEWAY_TOKEN);
    expect(logRecords(chunks)).toEqual([
      { level: 50, msg: "Log record could not be safely redacted" },
    ]);
  });

  it("leaves non-credential log fields, deep structures, and numeric values intact", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    log.info(
      {
        value: 4096,
        metric: "plugin.host.memory",
        depth1: { depth2: { depth3: { depth4: { depth5: { kept: "yes" } } } } },
        outcome: { status: "ok", mechanism: "streamable_http" },
      },
      "plugin host metric",
    );

    const [record] = logRecords(chunks);
    expect(record.value).toBe(4096);
    expect(record.metric).toBe("plugin.host.memory");
    expect(record.depth1.depth2.depth3.depth4.depth5.kept).toBe("yes");
    expect(record.outcome).toEqual({
      status: "ok",
      mechanism: "streamable_http",
    });
  });

  it("strips credential query parameters from the request URL and message", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(productionLogger(chunks)));
    app.get("/api/tool-gateway/tools", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app)
      .get(
        `/api/tool-gateway/tools?sessionToken=${SESSION_TOKEN}&gatewayToken=${GATEWAY_TOKEN}`,
      )
      .expect(200);

    const output = chunks.join("");
    expect(output).not.toContain(SESSION_TOKEN);
    expect(output).not.toContain(GATEWAY_TOKEN);

    const [log] = logRecords(chunks);
    expect(log.msg).toBe("GET /api/tool-gateway/tools 200");
    expect(log.req.url).toBe("/api/tool-gateway/tools");
    expect(log.req.query).toBeUndefined();
  });

  it.each([
    {
      label: "minted session token",
      input: `rejected ${SESSION_TOKEN} at authenticate`,
      expected: "rejected [REDACTED] at authenticate",
    },
    {
      label: "minted gateway token",
      input: `token=${GATEWAY_TOKEN} expired`,
      expected: "token=[REDACTED] expired",
    },
    {
      label: "bearer credential with trailing punctuation",
      input: "Request failed: Authorization: Bearer sk-live-7a91b2c3d4.",
      expected: "Request failed: Authorization: Bearer [REDACTED].",
    },
    {
      label: "all-lowercase opaque bearer token",
      input: "rejected Bearer abcdefghijklmnop for connector acme",
      expected: "rejected Bearer [REDACTED] for connector acme",
    },
    {
      label: "Basic credential after an Authorization label",
      input: 'upstream echoed "Authorization: Basic dXNlcjpzZWNyZXQ="',
      expected: 'upstream echoed "Authorization: Basic [REDACTED]"',
    },
    {
      label: "credential in a URL query",
      input: `retrying https://gw.invalid/mcp?token=${GATEWAY_TOKEN}&tool=add`,
      expected: "retrying https://gw.invalid/mcp?token=[REDACTED]&tool=add",
    },
  ])("removes credential material from prose: $label", ({ input, expected }) => {
    expect(sanitizeCredentialText(input)).toBe(expected);
  });

  it.each([
    {
      label: "documentation placeholder",
      input: "Empty bearer token; provide Authorization: Bearer <token>",
    },
    {
      label: "prose naming the header",
      input: "Bearer authorization header is missing",
    },
    {
      label: "prose naming the scheme",
      input: "Expected a Bearer token, received Basic auth",
    },
    {
      label: "already-redacted text stays stable",
      input: "Failed with Authorization: Bearer [REDACTED]",
    },
    {
      label: "the ordinary word digest",
      input: "checksum digest mismatch for artifact report.pdf",
    },
    {
      label: "the ordinary word basic",
      input: "basic validation failed for field name",
    },
    {
      label: "safe gateway token fingerprint",
      input: "rejected token pcgw_66666666 in phase authenticate",
    },
  ])("keeps safe diagnostic prose unchanged: $label", ({ input }) => {
    expect(sanitizeCredentialText(input)).toBe(input);
  });

  it("replaces Node HTTP objects with a content-free projection", () => {
    const incoming = new IncomingMessage(null as never);
    incoming.method = "POST";
    incoming.headers = { authorization: `Bearer ${BEARER_SENTINEL}` };

    const redacted = redactCredentialFields({
      message: "provider call failed",
      request: incoming,
    }) as { message: string; request: unknown };
    expect(redacted.request).toEqual({ type: "[HttpObject]", method: "POST" });
    expect(redacted.message).toBe("provider call failed");
    expect(JSON.stringify(redacted)).not.toContain(BEARER_SENTINEL);

    const serializedError = sanitizeErrorObject(
      Object.assign(new Error("provider call failed"), { request: incoming }),
    ) as { request: unknown };
    expect(serializedError.request).toEqual({
      type: "[HttpObject]",
      method: "POST",
    });
  });

  it("bounds a cyclic error property instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { stage: "connect" };
    cyclic.self = cyclic;
    const error = Object.assign(
      new Error(`connect failed for ${GATEWAY_TOKEN}`),
      { context: cyclic },
    );

    const serialized = sanitizeErrorObject(error) as {
      message: string;
      context: { stage: string; self: unknown };
    };
    expect(serialized.message).toBe("connect failed for [REDACTED]");
    expect(serialized.context.stage).toBe("connect");
    expect(serialized.context.self).toBe("[Circular]");

    const chunks: string[] = [];
    const log = productionLogger(chunks);
    log.error({ err: error }, "cyclic provider failure");
    const [record] = logRecords(chunks);
    expect(record.err.message).toBe("connect failed for [REDACTED]");
    expect(record.err.context.self).toBe("[Circular]");
    expect(record.msg).toBe("cyclic provider failure");
  });

  it("stops descending a deeply nested error property instead of recursing forever", () => {
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let level = 0; level < 12; level += 1) deep = { next: deep };
    const serialized = sanitizeErrorObject(
      Object.assign(new Error("boom"), { details: deep }),
    ) as Record<string, any>;

    let cursor: any = serialized.details;
    let levels = 0;
    while (cursor && typeof cursor === "object" && "next" in cursor) {
      cursor = cursor.next;
      levels += 1;
    }
    expect(cursor).toBeUndefined();
    expect(levels).toBeGreaterThan(0);
    expect(levels).toBeLessThan(12);
  });

  it("keeps array-valued error properties as arrays", () => {
    const aggregate = new AggregateError(
      [
        new Error(`first leg failed for ${GATEWAY_TOKEN}`),
        new Error("second leg failed"),
      ],
      "all gateway legs failed",
    );

    const chunks: string[] = [];
    const log = productionLogger(chunks);
    log.error({ err: aggregate }, "aggregate provider failure");

    const output = chunks.join("");
    expect(output).not.toContain(GATEWAY_TOKEN);

    const [record] = logRecords(chunks);
    expect(Array.isArray(record.err.aggregateErrors)).toBe(true);
    expect(record.err.aggregateErrors).toHaveLength(2);
    expect(record.err.aggregateErrors[0].message).toBe(
      "first leg failed for [REDACTED]",
    );
    expect(record.err.aggregateErrors[1].message).toBe("second leg failed");

    const serialized = sanitizeErrorObject(
      Object.assign(new Error("validation failed"), {
        issues: [{ path: ["credentials"], code: "invalid" }],
      }),
    ) as { issues: unknown };
    expect(Array.isArray(serialized.issues)).toBe(true);
    expect(serialized.issues).toEqual([
      { path: ["credentials"], code: "invalid" },
    ]);
  });

  it("redacts credential header names from a captured request body", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(productionLogger(chunks)));
    app.post("/api/tool-gateway/register", (_req, res) => {
      res.status(422).json({ error: "invalid registration" });
    });

    await request(app)
      .post("/api/tool-gateway/register")
      .send({
        cookie: "sid=body-cookie-sentinel",
        "proxy-authorization": "Basic Ym9keS1wcm94eS1zZW50aW5lbA==",
        "x-api-key": "body-api-key-sentinel",
        "x-csrf-token": "body-csrf-sentinel",
        "x-telegram-bot-api-secret-token": "body-telegram-sentinel",
        "x-paperclip-tool-gateway-token": GATEWAY_TOKEN,
        gatewayToken: SESSION_TOKEN,
        toolGatewayToken: SESSION_TOKEN,
        connectorId: "acme-crm",
      })
      .expect(422);

    const output = chunks.join("");
    for (const sentinel of [
      "body-cookie-sentinel",
      "Ym9keS1wcm94eS1zZW50aW5lbA==",
      "body-api-key-sentinel",
      "body-csrf-sentinel",
      "body-telegram-sentinel",
      GATEWAY_TOKEN,
      SESSION_TOKEN,
    ]) {
      expect(output).not.toContain(sentinel);
    }

    const [log] = logRecords(chunks);
    expect(log.reqBody).toEqual({
      cookie: "[Redacted]",
      "proxy-authorization": "[Redacted]",
      "x-api-key": "[Redacted]",
      "x-csrf-token": "[Redacted]",
      "x-telegram-bot-api-secret-token": "[Redacted]",
      "x-paperclip-tool-gateway-token": "[Redacted]",
      gatewayToken: "[Redacted]",
      toolGatewayToken: "[Redacted]",
      connectorId: "acme-crm",
    });
  });

  it("projects a live HTTP object logged under an ordinary key", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const upstream = new IncomingMessage(null as never);
    upstream.method = "GET";
    upstream.headers = { authorization: `Bearer ${BEARER_SENTINEL}` };

    log.info({ upstreamResponse: upstream, stage: "relay" }, "relayed upstream");

    const output = chunks.join("");
    expect(output).not.toContain(BEARER_SENTINEL);

    const [record] = logRecords(chunks);
    expect(record.upstreamResponse).toEqual({
      type: "[HttpObject]",
      method: "GET",
    });
    expect(record.stage).toBe("relay");
  });

  it("still lets pino's own req and res serializers project the live objects", async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(productionLogger(chunks)));
    app.get("/api/tool-gateway/tools", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app)
      .get("/api/tool-gateway/tools")
      .set("Authorization", `Bearer ${BEARER_SENTINEL}`)
      .expect(200);

    const [log] = logRecords(chunks);
    expect(log.res.statusCode).toBe(200);
    expect(log.req.method).toBe("GET");
    expect(log.req.headers.authorization).toBe("[Redacted]");
  });

  it("redacts a credential name in every separator spelling", () => {
    const redacted = redactCredentialFields({
      proxyAuthorization: "proxy-auth-sentinel-1",
      proxy_authorization: "proxy-auth-sentinel-2",
      "proxy-authorization": "proxy-auth-sentinel-3",
      setCookie: "sid=set-cookie-sentinel",
      xApiKey: "x-api-key-sentinel",
      gateway_token: SESSION_TOKEN,
      connectorId: "acme-crm",
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toMatch(
      /proxy-auth-sentinel|set-cookie-sentinel|x-api-key-sentinel/,
    );
    expect(redacted.proxyAuthorization).toBe("[Redacted]");
    expect(redacted.proxy_authorization).toBe("[Redacted]");
    expect(redacted["proxy-authorization"]).toBe("[Redacted]");
    expect(redacted.setCookie).toBe("[Redacted]");
    expect(redacted.xApiKey).toBe("[Redacted]");
    expect(redacted.gateway_token).toBe("[Redacted]");
    expect(redacted.connectorId).toBe("acme-crm");
  });

  it("still redacts a credential in a sibling subtree when one field getter throws", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const record = {
      stage: "relay",
      probe: {
        get lastResult(): string {
          throw new Error("getter exploded");
        },
      },
      connection: {
        authorization: `Bearer ${BEARER_SENTINEL}`,
        gatewayToken: SESSION_TOKEN,
        connectorId: "acme-crm",
      },
    };

    log.warn(record, "relay diagnostics");

    const output = chunks.join("");
    expect(output).not.toContain(BEARER_SENTINEL);
    expect(output).not.toContain(SESSION_TOKEN);

    const [written] = logRecords(chunks);
    expect(written.probe.lastResult).toBe("[Unreadable]");
    expect(written.connection.authorization).toBe("[Redacted]");
    expect(written.connection.gatewayToken).toBe("[Redacted]");
    expect(written.connection.connectorId).toBe("acme-crm");
    expect(written.stage).toBe("relay");
  });

  it("marks an array element's unreadable fields without losing the rest of the array", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const hostileElement = new Proxy(
      { authorization: "unused", detail: "unused" },
      {
        get() {
          throw new Error("get trap exploded");
        },
      },
    );

    log.warn(
      {
        attempts: [
          hostileElement,
          { gatewayToken: SESSION_TOKEN, durationMs: 12 },
        ],
      },
      "gateway attempts",
    );

    const output = chunks.join("");
    expect(output).not.toContain(SESSION_TOKEN);

    const [written] = logRecords(chunks);
    expect(Array.isArray(written.attempts)).toBe(true);
    expect(written.attempts[0]).toEqual({
      authorization: "[Redacted]",
      detail: "[Unreadable]",
    });
    expect(written.attempts[1]).toEqual({
      gatewayToken: "[Redacted]",
      durationMs: 12,
    });
  });

  it("returns a record it cannot read at all unchanged, without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("get trap exploded");
        },
        ownKeys() {
          throw new Error("ownKeys trap exploded");
        },
      },
    );
    expect(redactCredentialFields(hostile)).toBe(hostile);
  });

  it("redacts a record whose proxy trap throws only for the HTTP-object probe", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const record = new Proxy(
      { stage: "relay", context: { gatewayToken: SESSION_TOKEN } },
      {
        get(target, key, receiver) {
          if (key === "pipe") throw new Error("probe trap exploded");
          return Reflect.get(target, key, receiver);
        },
      },
    );

    log.warn(record, "relay diagnostics");

    expect(chunks.join("")).not.toContain(SESSION_TOKEN);
    const [written] = logRecords(chunks);
    expect(written.stage).toBe("relay");
    expect(written.context).toEqual({ gatewayToken: "[Redacted]" });
  });

  it("redacts the rest of the record when a value under req throws in the HTTP-object probe", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const hostileRequest = new Proxy(
      { url: "/api/tool-gateway/tools" },
      {
        get(target, key, receiver) {
          if (key === "pipe") throw new Error("probe trap exploded");
          return Reflect.get(target, key, receiver);
        },
      },
    );

    log.warn(
      { req: hostileRequest, context: { gatewayToken: SESSION_TOKEN } },
      "relay diagnostics",
    );

    expect(chunks.join("")).not.toContain(SESSION_TOKEN);
    const [written] = logRecords(chunks);
    expect(written.context).toEqual({ gatewayToken: "[Redacted]" });
  });

  it("returns a credential-free record, arrays included, by identity", () => {
    const record = {
      stage: "relay",
      attempts: [{ durationMs: 12 }, "retry"],
      nested: { ok: true },
    };
    expect(redactCredentialFields(record)).toBe(record);
  });

  it("writes the record instead of throwing when a nested field getter throws", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const record = {
      stage: "relay",
      context: {
        get lazyDetail(): string {
          throw new Error("getter exploded");
        },
      },
    };

    expect(() => log.warn(record, "relay diagnostics")).not.toThrow();
    const [written] = logRecords(chunks);
    expect(written.msg).toBe("relay diagnostics");
    expect(written.stage).toBe("relay");
  });

  it("redacts credential names nested anywhere inside a log record", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    const record = {
      outcome: "rejected",
      context: {
        connection: {
          authorization: `Bearer ${BEARER_SENTINEL}`,
          "x-paperclip-tool-gateway-token": GATEWAY_TOKEN,
          connectorId: "acme-crm",
        },
        attempts: [{ gatewayToken: SESSION_TOKEN, durationMs: 12 }],
      },
    };
    log.warn(record, "gateway attempt rejected");

    const output = chunks.join("");
    expect(output).not.toContain(BEARER_SENTINEL);
    expect(output).not.toContain(GATEWAY_TOKEN);
    expect(output).not.toContain(SESSION_TOKEN);

    const [written] = logRecords(chunks);
    expect(written.context.connection.authorization).toBe("[Redacted]");
    expect(written.context.connection["x-paperclip-tool-gateway-token"]).toBe(
      "[Redacted]",
    );
    expect(written.context.connection.connectorId).toBe("acme-crm");
    expect(written.context.attempts[0].gatewayToken).toBe("[Redacted]");
    expect(written.context.attempts[0].durationMs).toBe(12);
    expect(record.context.connection.authorization).toBe(
      `Bearer ${BEARER_SENTINEL}`,
    );
  });

  it("redacts credential-named fields without renaming ordinary diagnostic keys", () => {
    const redacted = redactCredentialFields({
      session: {
        gatewayToken: GATEWAY_TOKEN,
        metadata: { toolGatewayToken: SESSION_TOKEN },
      },
      signature: "sha256=8c1f",
      capability: "issues:read",
      note: `raw ${GATEWAY_TOKEN} echoed by a provider`,
    }) as any;

    expect(JSON.stringify(redacted)).not.toContain(GATEWAY_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(SESSION_TOKEN);
    expect(redacted.session.gatewayToken).toBe("[Redacted]");
    expect(redacted.session.metadata.toolGatewayToken).toBe("[Redacted]");
    expect(redacted.signature).toBe("sha256=8c1f");
    expect(redacted.capability).toBe("issues:read");
    expect(redacted.note).toBe("raw [REDACTED] echoed by a provider");
  });

  it("strips credential text from string fields of a structured record", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);

    log.warn(
      {
        detail: `provider replied 401 to Authorization: Bearer ${BEARER_SENTINEL}`,
        attempts: [`retry with ${SESSION_TOKEN}`],
        connectorId: "acme-crm",
      },
      "gateway call rejected",
    );

    const output = chunks.join("");
    expect(output).not.toContain(BEARER_SENTINEL);
    expect(output).not.toContain(SESSION_TOKEN);
    const [written] = logRecords(chunks);
    expect(written.detail).toBe("provider replied 401 to Authorization: Bearer [REDACTED]");
    expect(written.attempts).toEqual(["retry with [REDACTED]"]);
    expect(written.connectorId).toBe("acme-crm");
  });

  it("writes the record when a logged error has a throwing property", () => {
    const chunks: string[] = [];
    const log = productionLogger(chunks);
    const error = new Error(`connect failed for ${GATEWAY_TOKEN}`);
    Object.defineProperty(error, "detail", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(() => log.error({ err: error, stage: "connect" }, "provider failure")).not.toThrow();

    expect(chunks.join("")).not.toContain(GATEWAY_TOKEN);
    const [written] = logRecords(chunks);
    expect(written.msg).toBe("provider failure");
    expect(written.stage).toBe("connect");
    expect(written.err).toEqual({ type: "Error", message: "[Unreadable]" });
  });
});
