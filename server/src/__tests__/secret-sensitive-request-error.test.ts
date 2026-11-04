import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  isSecretSensitiveHttpRequest,
  secretSensitiveRouteFamily,
} from "../middleware/http-log-policy.js";
import { SecretSensitiveRequestError } from "../middleware/secret-sensitive-request-error.js";

const facts = { routeFamily: "chat_endpoint_setup", method: "POST", routePath: "/:id/setup" } as const;

describe("SecretSensitiveRequestError", () => {
  it("keeps the generic message and its own stack", () => {
    const original = Object.assign(new Error("echoed canary-token"), { name: "canary-token" });

    const error = new SecretSensitiveRequestError(original, facts);

    expect(error.name).toBe("Error");
    expect(error.message).toBe("Secret-sensitive request failed");
    expect(error.stack).not.toContain("canary-token");
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error.diagnostics)).not.toContain("canary-token");
  });

  it("records the route family, method, status, kind and route definition", () => {
    const error = new SecretSensitiveRequestError(new HttpError(503, "provider said canary-token"), facts);

    expect(error.diagnostics).toMatchObject({
      routeFamily: "chat_endpoint_setup",
      method: "POST",
      status: 503,
      errorKind: "http_error",
      errnoCode: null,
      databaseErrorCode: null,
      routePattern: "/:id/setup",
    });
  });

  it.each([
    [new TypeError("x"), "type_error"],
    [new RangeError("x"), "range_error"],
    [new ReferenceError("x"), "reference_error"],
    [new SyntaxError("x"), "syntax_error"],
    [new Error("x"), "error"],
    ["thrown string", "non_error"],
  ])("labels %s as %s", (original, kind) => {
    expect(new SecretSensitiveRequestError(original, facts).diagnostics.errorKind).toBe(kind);
  });

  it("uses closed or code-shaped values and drops everything else", () => {
    const original = Object.assign(new Error("x"), { code: "canary-token" });
    const error = new SecretSensitiveRequestError(original, {
      routeFamily: "provider_webhook",
      method: "canary-token",
      routePath: /canary-token/,
    });

    expect(error.diagnostics).toMatchObject({
      method: "other",
      status: 500,
      errnoCode: null,
      databaseErrorCode: null,
      routePattern: null,
    });
    expect(new SecretSensitiveRequestError(new Error("x"), { ...facts, routePath: "/:id?token=canary-token" })
      .diagnostics.routePattern).toBeNull();
  });

  it("reads errno and SQLSTATE codes from own data properties in the cause chain", () => {
    const database = Object.assign(new Error("duplicate key canary-token"), { code: "23505" });
    const network = Object.assign(new Error("connect failed", { cause: database }), { code: "ECONNREFUSED" });
    const wrapper = new Error("wrapped", { cause: network });

    expect(new SecretSensitiveRequestError(wrapper, facts).diagnostics).toMatchObject({
      errnoCode: "ECONNREFUSED",
      databaseErrorCode: "23505",
    });

    const getterCode = new Error("x");
    Object.defineProperty(getterCode, "code", { get: () => "ECONNRESET" });
    expect(new SecretSensitiveRequestError(getterCode, facts).diagnostics.errnoCode).toBeNull();
  });

  it("keeps well-formed original stack frames and drops message and injected lines", () => {
    const original = new Error("x");
    original.stack = [
      "Error: provider echoed canary-token",
      "second message line canary-token",
      "    at SlackSetup.verify (/app/server/dist-runtime/server.mjs:120:7)",
      "    at async Promise.all (index 0)",
      "    at canary-token (https://example.test/?token=canary-token:1:2)",
      "    at /app/node_modules/.pnpm/router@2.2.0/node_modules/router/lib/layer.js:152:17",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");

    expect(new SecretSensitiveRequestError(original, facts).diagnostics.originFrames).toEqual([
      "at SlackSetup.verify (/app/server/dist-runtime/server.mjs:120:7)",
      "at /app/node_modules/.pnpm/router@2.2.0/node_modules/router/lib/layer.js:152:17",
      "at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ]);
  });

  it("caps origin frames", () => {
    const original = new Error("x");
    original.stack = ["Error: x", ...Array.from({ length: 20 }, (_, i) => `    at f${i} (/app/a.js:${i + 1}:1)`)].join("\n");

    expect(new SecretSensitiveRequestError(original, facts).diagnostics.originFrames).toHaveLength(8);
  });
});

describe("secretSensitiveRouteFamily", () => {
  it("names the policy branch with a fixed label", () => {
    for (const [method, url, family] of [
      ["POST", "/api/chat-webhooks/endpoint-1/slack", "provider_webhook"],
      ["GET", "/api/muse/v1/commands", "muse"],
      ["GET", "/mcp/files/file-1", "mcp_files"],
      ["POST", "/api/companies/company/agent-commentary", "agent_commentary"],
      ["PUT", "/api/companies/company/observability", "agent_observability"],
      ["POST", "/MCP/RUNNER/call", "mcp_runner"],
      ["POST", "/api/companies/company/agents/agent/avatar", "agent_avatar"],
      ["GET", "/api/chat-slack/oauth/callback?code=private", "chat_slack_oauth"],
      ["POST", "/api/chat-endpoints/id/slack/install", "chat_endpoint_slack"],
      ["POST", "/api/companies/company/voice-sessions", "voice_sessions"],
      ["POST", "/mcp/oauth/token", "mcp_oauth"],
      ["POST", "/api/mcp/tools", "api_mcp"],
      ["POST", "/api/chat-endpoints/id/setup-secret", "chat_endpoint_setup"],
    ] as const) {
      expect(secretSensitiveRouteFamily(method, url)).toBe(family);
      expect(isSecretSensitiveHttpRequest(method, url)).toBe(true);
    }
  });

  it("returns null wherever the request is not secret-sensitive", () => {
    for (const [method, url] of [
      ["GET", "/api/chat-endpoints/id/setup"],
      ["POST", "/api/chat-endpoints/id/test"],
      ["GET", "/api/mcp/tools"],
      [undefined, "/api/mcp/tools"],
      ["POST", undefined],
    ] as const) {
      expect(secretSensitiveRouteFamily(method, url)).toBeNull();
      expect(isSecretSensitiveHttpRequest(method, url)).toBe(false);
    }
  });
});

describe("secret-sensitive Sentry capture", () => {
  const BACKEND_DSN_ENV = "SENTRY_DSN_BACKEND";
  const originalBackendDsn = process.env[BACKEND_DSN_ENV];

  afterEach(() => {
    if (originalBackendDsn === undefined) delete process.env[BACKEND_DSN_ENV];
    else process.env[BACKEND_DSN_ENV] = originalBackendDsn;
    vi.doUnmock("@sentry/node");
    vi.doUnmock("../peer-version-check.js");
  });

  it("reports where the request failed without its private values", async () => {
    // `@sentry/node` is optional and not installed in CI; open the gate with a fake.
    process.env[BACKEND_DSN_ENV] = "https://fixture@example.com/1";
    const captureException = vi.fn((_error: unknown, _hint?: unknown) => "event-id");
    vi.doMock("@sentry/node", () => ({
      getClient: () => ({ on: vi.fn() }),
      init: vi.fn(),
      captureException,
      close: vi.fn(async () => true),
      httpIntegration: vi.fn((options: unknown) => ({ name: "Http", ...(options as object) })),
      onUnhandledRejectionIntegration: vi.fn((options: unknown) => ({ name: "OnUnhandledRejection", ...(options as object) })),
    }));
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.resetModules();
    const { sentryReady } = await import("../sentry.js");
    const { errorHandler } = await import("../middleware/error-handler.js");
    const { HttpError: FreshHttpError } = await import("../errors.js");
    await sentryReady;
    const app = express();
    app.use(express.json());
    app.put("/api/companies/:companyId/observability", () => {
      const database = Object.assign(new Error("duplicate canary-api-key"), { code: "23505" });
      throw Object.assign(new TypeError("provider echoed canary-api-key", { cause: database }), {
        name: "canary-api-key",
        code: "ECONNREFUSED",
      });
    });
    app.post("/api/chat-endpoints/:id/setup", () => {
      throw new FreshHttpError(503, "provider echoed canary-api-key", { token: "canary-api-key" });
    });
    app.use(errorHandler);

    const res = await request(app)
      .put("/api/companies/company-1/observability?token=canary-api-key")
      .send({ credentials: { apiKey: "canary-api-key" } });
    const setupRes = await request(app).post("/api/chat-endpoints/endpoint-1/setup").send({ botToken: "canary-api-key" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(setupRes.status).toBe(503);
    expect(setupRes.body).toEqual({ error: "Internal server error" });
    expect(captureException).toHaveBeenCalledTimes(2);
    const [reported, hint] = captureException.mock.calls[0] as [Error, { tags: Record<string, string>; contexts: Record<string, Record<string, unknown>>; fingerprint: string[] }];
    expect(reported).toMatchObject({ name: "Error", message: "Secret-sensitive request failed" });
    expect(hint.fingerprint).toEqual(["{{ default }}"]);
    expect(hint.tags).toEqual({
      secret_route_family: "agent_observability",
      http_method: "PUT",
      http_status: "500",
      error_kind: "type_error",
      errno_code: "ECONNREFUSED",
      db_error_code: "23505",
    });
    expect(hint.contexts.secret_sensitive_request).toMatchObject({
      routeFamily: "agent_observability",
      routePattern: "/api/companies/:companyId/observability",
    });
    const frames = hint.contexts.secret_sensitive_request!.originFrames as string[];
    expect(frames.some((frame) => frame.includes("secret-sensitive-request-error.test.ts"))).toBe(true);
    expect(captureException.mock.calls[1]![1]).toMatchObject({
      tags: { secret_route_family: "chat_endpoint_setup", http_method: "POST", http_status: "503", error_kind: "http_error" },
      contexts: { secret_sensitive_request: { routePattern: "/api/chat-endpoints/:id/setup" } },
    });
    expect(JSON.stringify(captureException.mock.calls)).not.toContain("canary-api-key");
    expect(String(reported.stack)).not.toContain("canary-api-key");
  });
});
