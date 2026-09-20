import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

const sinks = vi.hoisted(() => ({
  captureException: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
  telemetryClient: {},
}));
vi.mock("../sentry.js", () => ({ captureException: sinks.captureException }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => sinks.telemetryClient }));
vi.mock("@paperclipai/shared/telemetry", () => ({ trackErrorHandlerCrash: sinks.trackErrorHandlerCrash }));

function createApp(routeError?: Error) {
  const app = express();
  app.use(express.json());
  const handler = vi.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (routeError) return next(routeError);
    res.status(200).json({ received: req.body });
  });
  app.post("/api/echo", handler);
  app.patch("/api/echo", handler);
  const errorResponses: Array<express.Response & { err?: unknown; __errorContext?: unknown }> = [];
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    errorResponses.push(res);
    errorHandler(err, req, res, next);
  });
  return { app, handler, errorResponses };
}

describe("JSON parse error handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["truncated object", '{"body": "oops"'],
    ["invalid syntax", "private-request-canary is not json"],
    ["trailing garbage", '{"body": "ok"} trailing'],
    ["strict scalar", '"private-request-canary"'],
    ["credential-shaped body", '{"token":"private-request-canary","broken":'],
  ])("returns a safe 400 for %s without reporting a crash", async (_label, body) => {
    const { app, handler, errorResponses } = createApp();
    for (const method of ["post", "patch"] as const) {
      const response = await request(app)[method]("/api/echo")
        .set("Content-Type", "application/json")
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid JSON body" });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(sinks.captureException).not.toHaveBeenCalled();
    expect(sinks.trackErrorHandlerCrash).not.toHaveBeenCalled();
    expect(errorResponses).toHaveLength(2);
    for (const response of errorResponses) {
      expect(response.err).toBeUndefined();
      expect(response.__errorContext).toBeUndefined();
    }
  });

  it.each([
    { label: "object", body: { body: "valid comment" } },
    { label: "array", body: [{ body: "valid item" }] },
  ])(
    "passes a valid JSON $label through to the route handler", async ({ body }) => {
      const { app, handler } = createApp();
      const response = await request(app).post("/api/echo").send(body);
      expect(response.status).toBe(200);
      expect(response.body.received).toEqual(body);
      expect(handler).toHaveBeenCalledOnce();
      expect(sinks.captureException).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["application JSON parse error", new SyntaxError("Stored JSON is invalid")],
    ["other 400 syntax error", Object.assign(new SyntaxError("Stored JSON is invalid"), {
      status: 400, type: "application.parse.failed", body: "private-request-canary",
    })],
    ["wrong parser status", Object.assign(new SyntaxError("Parser failed"), {
      status: 500, type: "entity.parse.failed", body: "private-request-canary",
    })],
    ["non-syntax error", Object.assign(new Error("Parser failed"), {
      status: 400, type: "entity.parse.failed", body: "private-request-canary",
    })],
  ])("still reports %s as a server error", async (_label, error) => {
    const { app, handler, errorResponses } = createApp(error as Error);
    const response = await request(app).post("/api/echo").send({ body: "valid" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(handler).toHaveBeenCalledOnce();
    expect(sinks.captureException).toHaveBeenCalledExactlyOnceWith(error);
    expect(sinks.trackErrorHandlerCrash).toHaveBeenCalledExactlyOnceWith(sinks.telemetryClient, {
      errorCode: (error as Error).name,
    });
    expect(errorResponses[0].err).toBe(error);
  });

  it("keeps route authorization errors intact for valid JSON", async () => {
    const { app } = createApp(new HttpError(403, "Access denied"));
    const response = await request(app).post("/api/echo").send({ body: "valid" });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Access denied" });
    expect(sinks.captureException).not.toHaveBeenCalled();
    expect(sinks.trackErrorHandlerCrash).not.toHaveBeenCalled();
  });
});
