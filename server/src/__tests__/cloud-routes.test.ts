import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { cloudRoutes } from "../routes/cloud.js";
import { CloudPortfolioError } from "../services/cloud-portfolio-error.js";
import * as sentry from "../sentry.js";
import { logger } from "../middleware/logger.js";

afterEach(() => vi.restoreAllMocks());

const cloudEnv = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret",
  PAPERCLIP_CLOUD_STACK_ID: "stack-current",
  PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test/control-plane",
};

function cloudActor(userId: string) {
  return {
    type: "board" as const,
    source: "cloud_tenant" as const,
    userId,
    companyIds: ["company-1"],
  };
}

function createApp(options: {
  actor?: ReturnType<typeof cloudActor> | {
    type: "board";
    source: "session";
    userId: string;
  };
  runtimeEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = options.actor ?? cloudActor("actor-user");
    next();
  });
  app.use("/api/cloud", cloudRoutes({
    runtimeEnv: options.runtimeEnv ?? cloudEnv,
    fetchImpl: options.fetchImpl,
    now: options.now,
  }));
  app.use(errorHandler);
  return app;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/cloud/stacks", () => {
  it.each([401, 403, 429, 503])("preserves the response contract for upstream HTTP %s without reading the body", async (status) => {
    const upstream = jsonResponse({ secret: "private upstream payload" }, status);
    const json = vi.spyOn(upstream, "json");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const capture = vi.spyOn(sentry, "captureException").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const response = await request(createApp({ fetchImpl })).get("/api/cloud/stacks").set("Cookie", "client-session=private-cookie");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Paperclip Cloud portfolio request failed", code: "cloud_portfolio_upstream_error", details: { code: "cloud_portfolio_upstream_error" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).has("cookie")).toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(expect.any(CloudPortfolioError));
    const error = capture.mock.calls[0]![0] as CloudPortfolioError;
    expect(error.diagnostics).toMatchObject({ phase: "http_response", upstreamStatus: status, networkCode: "unknown", elapsedMs: expect.any(Number) });
    expect(error.stack).toContain("routes/cloud.ts:");
    expect(error.stack).not.toContain("at portfolioError");
    expect(warn).toHaveBeenCalledWith({ cloudPortfolio: error.diagnostics }, "Paperclip Cloud portfolio request failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("classifies a fetch reset without retrying or caching the failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("private fetch message", { cause: Object.assign(new Error("private cause"), { code: "ECONNRESET" }) }))
      .mockResolvedValueOnce(jsonResponse({ stacks: [] }));
    const capture = vi.spyOn(sentry, "captureException").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const app = createApp({ fetchImpl });
    const failure = await request(app).get("/api/cloud/stacks");
    expect(failure.status).toBe(502);
    expect(failure.body).toEqual({ error: "Paperclip Cloud portfolio request failed", code: "cloud_portfolio_upstream_error", details: { code: "cloud_portfolio_upstream_error" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const error = capture.mock.calls[0]![0] as CloudPortfolioError;
    expect(error.diagnostics).toMatchObject({ phase: "fetch", upstreamStatus: null, networkCode: "ECONNRESET" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    expect((await request(app).get("/api/cloud/stacks")).body).toEqual({ stacks: [] });
    expect((await request(app).get("/api/cloud/stacks")).body).toEqual({ stacks: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid_json", "body_reset", "deadline"] as const)("keeps body-phase %s failures separate from fetch failures", async (kind) => {
    const capture = vi.spyOn(sentry, "captureException").mockImplementation(() => {});
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const upstream = jsonResponse({});
    vi.spyOn(upstream, "json").mockImplementation(async () => {
      if (kind === "deadline") controller.abort(new DOMException("private timeout", "TimeoutError"));
      throw kind === "body_reset" ? Object.assign(new Error("private body"), { code: "ECONNRESET" }) : new SyntaxError("private body");
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const app = createApp({ fetchImpl });
    for (let count = 1; count <= 2; count++) {
      const response = await request(app).get("/api/cloud/stacks");
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: "Paperclip Cloud portfolio returned invalid JSON", code: "cloud_portfolio_invalid_response", details: { code: "cloud_portfolio_invalid_response" } });
      expect(fetchImpl).toHaveBeenCalledTimes(count);
    }
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect((capture.mock.calls[0]![0] as CloudPortfolioError).diagnostics).toMatchObject({
      phase: "response_body", upstreamStatus: 200,
      networkCode: kind === "deadline" ? "DEADLINE_EXCEEDED" : kind === "body_reset" ? "ECONNRESET" : "unknown",
    });
  });

  it("records the owned fetch deadline without changing the ten-second signal", async () => {
    const signal = AbortSignal.abort(new DOMException("private timeout", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(signal.reason);
    const capture = vi.spyOn(sentry, "captureException").mockImplementation(() => {});
    const response = await request(createApp({ fetchImpl })).get("/api/cloud/stacks");
    expect(response.body).toEqual({ error: "Paperclip Cloud portfolio request failed", code: "cloud_portfolio_upstream_error", details: { code: "cloud_portfolio_upstream_error" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(signal);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect((capture.mock.calls[0]![0] as CloudPortfolioError).diagnostics).toMatchObject({ phase: "fetch", networkCode: "DEADLINE_EXCEEDED" });
  });

  it("does not mislabel a response serialization failure as an upstream fetch error", async () => {
    const payload: { cycle?: unknown } = {};
    payload.cycle = payload;
    const upstream = jsonResponse({});
    vi.spyOn(upstream, "json").mockResolvedValue(payload);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const capture = vi.spyOn(sentry, "captureException").mockImplementation(() => {});
    const response = await request(createApp({ fetchImpl })).get("/api/cloud/stacks");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Paperclip Cloud portfolio request failed", code: "cloud_portfolio_upstream_error", details: { code: "cloud_portfolio_upstream_error" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0]![0] as CloudPortfolioError).diagnostics).toMatchObject({ phase: "response_write", upstreamStatus: 200, networkCode: "unknown" });
  });

  it("returns the actor's portfolio without forwarding client-supplied identity", async () => {
    const portfolio = { stacks: [{ slug: "current", displayName: "Current" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(portfolio));
    const app = createApp({ fetchImpl });

    const res = await request(app)
      .get("/api/cloud/stacks?userId=client-supplied-user")
      .set("x-paperclip-cloud-user-id", "spoofed-header-user")
      .set("authorization", "Bearer client-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(portfolio);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe("https://cloud.example.test/v1/tenant/portfolio");
    expect(init).toMatchObject({ method: "GET" });
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer tenant-secret",
      "x-paperclip-cloud-user-id": "actor-user",
      "x-paperclip-cloud-stack-id": "stack-current",
    });
    expect(JSON.stringify(init)).not.toContain("client-supplied-user");
    expect(JSON.stringify(init)).not.toContain("spoofed-header-user");
    expect(JSON.stringify(init)).not.toContain("client-token");
  });

  it("caches successful portfolios per actor for 30 seconds", async () => {
    let currentTime = 1_000;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ generation: 1 }))
      .mockResolvedValueOnce(jsonResponse({ generation: 2 }));
    const app = createApp({ fetchImpl, now: () => currentTime });

    const first = await request(app).get("/api/cloud/stacks");
    currentTime += 29_999;
    const cached = await request(app).get("/api/cloud/stacks");
    currentTime += 1;
    const refreshed = await request(app).get("/api/cloud/stacks");

    expect(first.body).toEqual({ generation: 1 });
    expect(cached.body).toEqual({ generation: 1 });
    expect(refreshed.body).toEqual({ generation: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries isolated by the server-derived actor user id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      return jsonResponse({ userId: headers.get("x-paperclip-cloud-user-id") });
    });
    const app = express();
    app.use((req, _res, next) => {
      const userId = req.header("x-test-actor-user") ?? "user-a";
      (req as any).actor = cloudActor(userId);
      next();
    });
    app.use("/api/cloud", cloudRoutes({ runtimeEnv: cloudEnv, fetchImpl }));
    app.use(errorHandler);

    const first = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");
    const second = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-b");
    const firstAgain = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");

    expect(first.body).toEqual({ userId: "user-a" });
    expect(second.body).toEqual({ userId: "user-b" });
    expect(firstAgain.body).toEqual({ userId: "user-a" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns 404 on self-hosted instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ runtimeEnv: {}, fetchImpl });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-tenant actors on managed instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({
      actor: { type: "board", source: "session", userId: "session-user" },
      fetchImpl,
    });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("cloud_tenant_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
