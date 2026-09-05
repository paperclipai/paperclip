import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { ToolGatewayHttpError } from "../services/tool-gateway.js";

const recordResponsibleUserDenialOnActiveRunMock = vi.hoisted(() => vi.fn());

vi.mock("../services/responsible-user-denial-run-outcomes.js", () => ({
  recordResponsibleUserDenialOnActiveRun: recordResponsibleUserDenialOnActiveRunMock,
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
    expect(res.json).toHaveBeenCalledWith({ error: "Validation error", details: [issue] });
    expect(res.err).toBeUndefined();
    expect(res.__errorContext).toBeUndefined();
  });

  it("records responsible-user denial codes on the active agent run", () => {
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

    errorHandler(err, req, res, next);

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
  });

  // Regression: ToolGatewayHttpError previously extended the bare `Error`
  // class instead of `HttpError`, so `err instanceof HttpError` was false
  // here and every tool-gateway rejection (404s, 409s, ...) fell through to
  // the generic 500 branch below - masking the real status/reasonCode and
  // wrongly reporting expected business-rule rejections as crashes.
  it("maps a ToolGatewayHttpError to its own status instead of a generic 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new ToolGatewayHttpError(
      409,
      "Tool action request requires formal board approval before execution",
      "formal_approval_required",
      { approvalId: "approval-1" },
    );

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Tool action request requires formal board approval before execution",
      reasonCode: "formal_approval_required",
      details: { approvalId: "approval-1" },
    });
    // Sub-500 statuses must not be attached/reported as a server crash.
    expect(res.err).toBeUndefined();
    expect(res.__errorContext).toBeUndefined();
  });

  it("still reports a ToolGatewayHttpError as a crash when its status is >= 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new ToolGatewayHttpError(502, "Remote MCP tool call timed out", "tool_timeout");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("Remote MCP tool call timed out");
  });
});
