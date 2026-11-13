import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { ToolGatewayHttpError } from "../services/tool-gateway.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());
const trackErrorHandlerCrashMock = vi.hoisted(() => vi.fn());

vi.mock("../services/responsible-user-denial-run-outcomes.js", () => ({
  recordResponsibleUserDenialOnActiveRun: vi.fn().mockResolvedValue(null),
}));
vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({}) }));
vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: trackErrorHandlerCrashMock,
}));

function makeReq(): Request {
  return {
    method: "POST",
    originalUrl: "/api/issues/issue-1/interactions/interaction-1/accept",
    body: {},
    params: {},
    query: {},
  } as unknown as Request;
}

function makeRes(): Response {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

function changedTargetError() {
  return new ToolGatewayHttpError(
    409,
    "Tool definition or connection changed; request a new review",
    "approved_tool_target_changed",
  );
}

describe("errorHandler with tool gateway errors", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    trackErrorHandlerCrashMock.mockReset();
  });

  it("answers an expected gateway rejection with its own status and reason, without a crash report", () => {
    const res = makeRes();

    errorHandler(changedTargetError(), makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: "Tool definition or connection changed; request a new review",
      code: "approved_tool_target_changed",
    }));
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(trackErrorHandlerCrashMock).not.toHaveBeenCalled();
  });

  it("keeps gateway server failures on the crash path without exposing provider text", () => {
    const error = new ToolGatewayHttpError(502, "provider said: secret detail", "mcp_remote_invalid_json");
    const res = makeRes();

    errorHandler(error, makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(captureExceptionMock).toHaveBeenCalledWith(error);
  });

  it("returns the 409 to a client whose route lets the gateway error escape", async () => {
    const app = express();
    app.post("/api/issues/:id/interactions/:interactionId/accept", async () => {
      throw changedTargetError();
    });
    app.use(errorHandler);

    const res = await request(app).post("/api/issues/issue-1/interactions/interaction-1/accept").send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "Tool definition or connection changed; request a new review",
      code: "approved_tool_target_changed",
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
