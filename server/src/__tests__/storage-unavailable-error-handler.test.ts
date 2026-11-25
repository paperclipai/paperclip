import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { recordStorageFailure } from "../storage/failure-diagnostics.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

function createApp(error: unknown) {
  const app = express();
  app.post("/work", async () => { throw error; });
  app.use(errorHandler);
  return app;
}

function storageFailure(error: Error, errorCode: string, httpStatus: number | null) {
  recordStorageFailure(error, { provider: "s3", operation: "read_object_body", errorCode, httpStatus, requestId: null, attempts: 3 });
  return error;
}

describe("storage failures in the error handler", () => {
  beforeEach(() => captureExceptionMock.mockReset());

  it("answers a storage connection reset with 503, not as a client abort", async () => {
    const reset = storageFailure(Object.assign(new Error("aborted"), { code: "ECONNRESET" }), "ECONNRESET", null);

    const res = await request(createApp(reset)).post("/work");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.code).toBe("storage_unavailable");
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("still reports a storage credential rejection as a server fault", async () => {
    const rejected = storageFailure(Object.assign(new Error("expired"), { name: "ExpiredToken" }), "ExpiredToken", 400);

    const res = await request(createApp(rejected)).post("/work");

    expect(res.status).toBe(500);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
