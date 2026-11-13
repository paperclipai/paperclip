import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { listOpenRouterModels } from "../services/openrouter-models.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

function createApp() {
  const app = express();
  app.get("/models", async (_req, res) => { res.json(await listOpenRouterModels(true)); });
  app.get("/other-outage", async () => { throw new HttpError(503, "Durable agent files require shared object storage"); });
  app.use(errorHandler);
  return app;
}

describe("OpenRouter catalog outages", () => {
  beforeEach(() => captureExceptionMock.mockReset());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("answers a stalled public catalog with retry guidance and no crash report", async () => {
    // PAPERCLIP-BACKEND-8D: the catalog request's own 10s deadline used to
    // reach this handler as a raw TimeoutError, answering 500 and paging Sentry.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    })));

    const res = await request(createApp()).get("/models");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Could not load OpenRouter models. Retry or enter a model ID manually.",
      code: "openrouter_catalog_unavailable",
      details: { code: "openrouter_catalog_unavailable" },
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("still reports other server-side 503 failures", async () => {
    const res = await request(createApp()).get("/other-outage");

    expect(res.status).toBe(503);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
