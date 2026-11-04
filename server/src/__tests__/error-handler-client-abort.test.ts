import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

// The S3 client rejects an aborted GetObject with this error.
function storageAbortError() {
  return Object.assign(new Error("Request aborted"), { name: "AbortError" });
}

/** A route that cancels its storage read when the response closes. */
function createApp(onReadStarted: () => void) {
  const app = express();
  app.get("/log", async (_req, res) => {
    const controller = new AbortController();
    const cancelRead = () => controller.abort();
    res.once("close", cancelRead);
    try {
      await new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(storageAbortError()));
        onReadStarted();
      });
    } finally {
      res.off("close", cancelRead);
    }
  });
  app.get("/failure", async () => {
    throw storageAbortError();
  });
  app.use(errorHandler);
  return app;
}

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("errorHandler client aborts", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it("does not report work cancelled because the client disconnected", async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    await withServer(createApp(() => readStarted()), async (baseUrl) => {
      const clientRequest = request(baseUrl).get("/log");
      const settled = clientRequest.then(() => undefined, () => undefined);
      await started;
      clientRequest.abort();
      await settled;
      // Let the route's rejection reach the error handler.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("still reports an AbortError while the client is connected", async () => {
    await withServer(createApp(() => {}), async (baseUrl) => {
      const response = await request(baseUrl).get("/failure");
      expect(response.status).toBe(500);
    });

    expect(captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: "AbortError",
      message: "Request aborted",
    }));
  });
});
