import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { errorHandler } from "../middleware/error-handler.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

const cleanup = {
  providerLeaseId: "paperclip-create-7c3c865d", companyId: "company-1", environmentId: "environment-1",
  attemptId: "7c3c865d", accountFingerprint: "a".repeat(64), labels: { "paperclip-provider": "daytona" },
};

function refusal(data: unknown) {
  return new JsonRpcCallError({ code: -32000,
    message: "Daytona sandbox creation failed (HTTP 502); cleanup could not be confirmed for paperclip-create-7c3c865d", data });
}

function createApp(error: unknown) {
  const app = express();
  app.post("/start", async () => { throw error; });
  app.use(errorHandler);
  return app;
}

describe("sandbox provider outages during a requested creation", () => {
  beforeEach(() => captureExceptionMock.mockReset());

  it("answers a transient create refusal with 503 and no crash report", async () => {
    // PAPERCLIP-BACKEND-75: a Daytona 502 reached this handler as a raw RPC
    // error, answering 500 with a crash report.
    const res = await request(createApp(refusal({ schema: "paperclip/environment-creation-cleanup/v1", cleanup,
      providerDiagnostic: { httpStatus: 502 } })))
      .post("/start");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({
      error: "The sandbox provider was temporarily unavailable (HTTP 502). Try again in a few minutes.",
      code: "environment_provider_unavailable",
    });
    expect(JSON.stringify(res.body)).not.toContain("paperclip-create-");
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("answers a connection failure and an expired creation deadline the same way", async () => {
    const reset = await request(createApp(refusal({ schema: "paperclip/environment-acquire-error/v1",
      providerDiagnostic: { errorCode: "ECONNRESET" } }))).post("/start");
    expect(reset.status).toBe(503);
    expect(reset.body.error).toBe("The sandbox provider was temporarily unavailable (ECONNRESET). Try again in a few minutes.");

    const deadline = await request(createApp(refusal({ schema: "paperclip/environment-creation-cleanup/v1", cleanup,
      acquisitionDiagnostic: { phase: "create", elapsedMs: 300_000, budgetMs: 300_000 } }))).post("/start");
    expect(deadline.status).toBe(503);
    expect(deadline.body.error).toBe("The sandbox provider did not finish starting the sandbox in time. Try again in a few minutes.");
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a definite provider status", refusal({ schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 401 } })],
    ["no structured evidence", refusal(undefined)],
    ["a forged envelope on another error", Object.assign(new Error("x"), { data: { schema: "paperclip/environment-acquire-error/v1",
      providerDiagnostic: { httpStatus: 502 } } })],
    ["a later Paperclip failure", new Error("Interactive setup sandbox cleanup could not be recorded", {
      cause: refusal({ schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 502 } }) })],
  ])("still reports %s as a server fault", async (_label, error) => {
    const res = await request(createApp(error)).post("/start");

    expect(res.status).toBe(500);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
