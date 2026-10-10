import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { mcpDiscoveryHttpFailure, retainMcpConnectionFailure } from "../services/mcp-connection-failure.js";

const recordResponsibleUserDenialOnActiveRunMock = vi.hoisted(() => vi.fn());
const rememberResponsibleUserDenialForRunMock = vi.hoisted(() => vi.fn());
const captureExceptionMock = vi.hoisted(() => vi.fn());
const telemetryMocks = vi.hoisted(() => ({
  client: {},
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../services/responsible-user-denial-run-outcomes.js", () => ({
  recordResponsibleUserDenialOnActiveRun:
    recordResponsibleUserDenialOnActiveRunMock,
  rememberResponsibleUserDenialForRun: rememberResponsibleUserDenialForRunMock,
}));

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => telemetryMocks.client,
}));
vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: telemetryMocks.trackErrorHandlerCrash,
}));

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  beforeEach(() => {
    recordResponsibleUserDenialOnActiveRunMock.mockReset();
    recordResponsibleUserDenialOnActiveRunMock.mockResolvedValue(null);
    rememberResponsibleUserDenialForRunMock.mockReset();
    captureExceptionMock.mockReset();
    telemetryMocks.trackErrorHandlerCrash.mockReset();
  });

  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("ends aborted client requests without reporting a crash", () => {
    // A closed tab or dropped network surfaces as `Error: aborted` with
    // ECONNRESET; there is no server fault and nobody left to answer.
    const req = makeReq();
    const res = { ...makeRes(), end: vi.fn(), headersSent: false } as any;
    (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
    const next = vi.fn() as unknown as NextFunction;
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(499);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(telemetryMocks.trackErrorHandlerCrash).not.toHaveBeenCalled();
  });

  it("exposes raw 500 messages for trusted Cloud tenant imports", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/companies/import",
      actor: {
        type: "board",
        userId: "cloud-user",
        source: "cloud_tenant",
      },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("portable file references missing upload id");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      message: "portable file references missing upload id",
    });
    expect(res.err).toBe(err);
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("keeps HTTP failures and existing telemetry for proven external MCP outages while skipping Sentry", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const original = mcpDiscoveryHttpFailure(new Response(null, { status: 503 }), "Remote app returned HTTP 503");
    const err = retainMcpConnectionFailure(original, new HttpError(502, original.message));

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: original.message });
    expect(res.err).toBe(err);
    expect(res.__errorContext.error.message).toBe(original.message);
    expect(telemetryMocks.trackErrorHandlerCrash).toHaveBeenCalledOnce();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("reports copied connection markers and unrelated database failures", () => {
    for (const err of [
      Object.assign(new HttpError(502, "Remote app returned HTTP 503", { status: 503 }), {
        connectionFailure: { schemaVersion: 1, provider: "mcp_http", operation: "discover_tools", reason: "remote_unavailable" },
      }),
      new HttpError(500, "database unavailable"),
    ]) {
      errorHandler(err, makeReq(), makeRes(), vi.fn());
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    expect(telemetryMocks.trackErrorHandlerCrash).toHaveBeenCalledTimes(2);
  });

  it("sanitizes chat setup errors before logs and crash reporting", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/chat-endpoints/endpoint-1/setup",
      body: { credentials: { botToken: "setup-error-token-canary" } },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("provider echoed setup-error-token-canary");
    err.name = "SecretName-setup-error-token-canary";

    errorHandler(err, req, res, next);

    expect(res.err).not.toBe(err);
    expect(res.err).toMatchObject({
      name: "Error",
      message: "Secret-sensitive request failed",
    });
    expect(res.__errorContext.error).toEqual({
      name: "Error",
      message: "Secret-sensitive request failed",
    });
    expect(captureExceptionMock).toHaveBeenCalledWith(res.err);
    expect(JSON.stringify(captureExceptionMock.mock.calls)).not.toContain(
      "setup-error-token-canary",
    );
    expect(telemetryMocks.trackErrorHandlerCrash).toHaveBeenCalledWith(
      telemetryMocks.client,
      { errorCode: "Error" },
    );
    expect(
      JSON.stringify(telemetryMocks.trackErrorHandlerCrash.mock.calls),
    ).not.toContain("setup-error-token-canary");
  });

  it("keeps actionable setup validation details while removing submitted credentials", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/chat-endpoints/endpoint-1/setup",
      body: { credentials: { botToken: "invalid-token-canary" } },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(
      422,
      "Missing required Slack scopes for invalid-token-canary",
      {
        code: "chat_provider_permissions_missing",
        credentials: { botToken: "invalid-token-canary" },
        explanation: "Provider rejected invalid-token-canary",
        requiredScopes: ["chat:write", "reactions:write"],
      },
    );

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing required Slack scopes for [REDACTED]",
      code: "chat_provider_permissions_missing",
      details: {
        code: "chat_provider_permissions_missing",
        credentials: "[REDACTED]",
        explanation: "Provider rejected [REDACTED]",
        requiredScopes: ["chat:write", "reactions:write"],
      },
    });
  });

  it("returns 400 for Zod validation errors from another module instance", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const issue = {
      code: "invalid_type",
      expected: "string",
      received: "undefined",
      path: ["provider"],
      message: "Required",
    };
    const err = Object.assign(new Error("Validation failed"), {
      name: "ZodError",
      issues: [issue],
      errors: [issue],
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Validation error",
      details: [issue],
    });
    expect(res.err).toBeUndefined();
    expect(res.__errorContext).toBeUndefined();
  });

  it("removes submitted credentials from setup Zod issue prose", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/chat-endpoints/endpoint-1/setup",
      body: { credentials: { botToken: "zod-token-canary" } },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const issue = {
      code: "custom",
      path: ["credentials", "botToken"],
      message: "Rejected zod-token-canary",
    };
    const err = Object.assign(new Error("Validation failed"), {
      name: "ZodError",
      issues: [issue],
      errors: [issue],
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Validation error",
      details: [
        {
          code: "custom",
          path: ["credentials", "botToken"],
          message: "Rejected [REDACTED]",
        },
      ],
    });
  });

  it("records responsible-user denial codes before sending the response", async () => {
    let resolveRecord!: (value: { id: string }) => void;
    recordResponsibleUserDenialOnActiveRunMock.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => {
        resolveRecord = resolve;
      }),
    );
    const db = { marker: "db" };
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: db } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    const handling = errorHandler(err, req, res, next);

    await Promise.resolve();
    expect(res.status).not.toHaveBeenCalled();

    resolveRecord({ id: "run-1" });
    await handling;

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is not authorized",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
      details: { code: "RESPONSIBLE_USER_UNAUTHORIZED" },
    });
    expect(recordResponsibleUserDenialOnActiveRunMock).toHaveBeenCalledWith(db, {
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
    expect(rememberResponsibleUserDenialForRunMock).not.toHaveBeenCalled();
  });

  it("fails the request when the responsible-user denial cannot be recorded", async () => {
    recordResponsibleUserDenialOnActiveRunMock.mockRejectedValueOnce(new Error("db down"));
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: { marker: "db" } } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    await errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is not authorized",
      code: "responsible_user_denial_not_recorded",
    });
  });

  it("retries the denial marker without terminalizing the run when the first write throws", async () => {
    recordResponsibleUserDenialOnActiveRunMock
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ id: "run-1", status: "running" });
    const db = { marker: "db" };
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: db } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    await errorHandler(err, req, res, next);

    expect(recordResponsibleUserDenialOnActiveRunMock).toHaveBeenCalledTimes(2);
    expect(rememberResponsibleUserDenialForRunMock).toHaveBeenCalledWith(
      "run-1",
      "RESPONSIBLE_USER_UNAUTHORIZED",
    );
    expect(recordResponsibleUserDenialOnActiveRunMock).toHaveBeenLastCalledWith(db, {
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("still answers 503 when the fallback denial marker also throws", async () => {
    recordResponsibleUserDenialOnActiveRunMock
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db still down"));
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: { marker: "db" } } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    await errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is not authorized",
      code: "responsible_user_denial_not_recorded",
    });
  });

  it("fails the request when no active run matched the denial", async () => {
    recordResponsibleUserDenialOnActiveRunMock.mockResolvedValueOnce(null);
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: { marker: "db" } } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    await errorHandler(err, req, res, next);

    expect(recordResponsibleUserDenialOnActiveRunMock).toHaveBeenCalledTimes(1);
    expect(rememberResponsibleUserDenialForRunMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is not authorized",
      code: "responsible_user_denial_not_recorded",
    });
  });

  it("keeps the plain denial response for agent calls made outside a run", async () => {
    recordResponsibleUserDenialOnActiveRunMock.mockResolvedValueOnce(null);
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: { marker: "db" } } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: null,
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is unavailable", {
      code: "RESPONSIBLE_USER_UNAVAILABLE",
    });

    await errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(rememberResponsibleUserDenialForRunMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is unavailable",
      code: "RESPONSIBLE_USER_UNAVAILABLE",
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
  });
});
