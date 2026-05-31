import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createApiRouteTimeoutMiddleware,
  createPollingBackpressureMiddleware,
  createPollingRateLimitAndCoalescingMiddleware,
} from "../middleware/api-route-guards.js";

describe("api route guards", () => {
  it("returns 503 when a non-streaming api route exceeds 10 seconds", async () => {
    const app = express();
    app.use("/api", createApiRouteTimeoutMiddleware({ timeoutMs: 20 }));
    app.get("/api/slow", async () => {
      await new Promise(() => {});
    });

    const res = await request(app).get("/api/slow");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "service_unavailable", reason: "timeout" });
  }, 10_000);

  it("does not timeout streaming event endpoints", async () => {
    const app = express();
    app.use("/api", createApiRouteTimeoutMiddleware({ timeoutMs: 20 }));
    app.get("/api/plugins/plugin-1/events", async (_req, res) => {
      setTimeout(() => {
        res.status(200).json({ ok: true });
      }, 30);
    });

    const res = await request(app).get("/api/plugins/plugin-1/events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  }, 10_000);

  it("applies per-company backpressure to polling routes at 3 in-flight requests", async () => {
    const middleware = createPollingBackpressureMiddleware({ maxInflight: 3, retryAfterSeconds: 5 });

    const activeResponses: Array<EventEmitter & { statusCode?: number; body?: unknown; headers: Record<string, string> }> = [];

    function buildReqRes() {
      const req = {
        method: "GET",
        originalUrl: "/api/companies/company-1/live-runs",
        url: "/api/companies/company-1/live-runs",
      };
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
          this.headers[name.toLowerCase()] = value;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          this.body = payload;
          this.emit("finish");
          return this;
        },
      });
      return { req, res };
    }

    for (let i = 0; i < 3; i += 1) {
      const { req, res } = buildReqRes();
      middleware(req as any, res as any, () => {});
      activeResponses.push(res);
    }

    const fourth = buildReqRes();
    middleware(fourth.req as any, fourth.res as any, () => {});
    expect(fourth.res.statusCode).toBe(429);
    expect(fourth.res.headers["retry-after"]).toBe("5");
    expect(fourth.res.body).toEqual({ error: "too_many_requests", reason: "backpressure" });

    activeResponses.forEach((res) => res.emit("finish"));
  });

  it("rate limits burst polling traffic per client with 429", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: "company-1", agentId: "agent-1" };
      next();
    });
    app.use(
      "/api",
      createPollingRateLimitAndCoalescingMiddleware({
        requestsPerMinute: 10,
      }),
    );
    app.get("/api/companies/company-1/dashboard", (_req, res) => {
      res.json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const res = await request(app).get("/api/companies/company-1/dashboard");
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("coalesces duplicate live-runs responses in a 1s window", async () => {
    const app = express();
    let liveRunsCalls = 0;
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: "company-1", agentId: "agent-1" };
      next();
    });
    app.use(
      "/api",
      createPollingRateLimitAndCoalescingMiddleware({
        requestsPerMinute: 100,
        liveRunsCoalesceWindowMs: 1_000,
      }),
    );
    app.get("/api/companies/company-1/live-runs", (_req, res) => {
      liveRunsCalls += 1;
      res.json({ calls: liveRunsCalls });
    });

    const first = await request(app).get("/api/companies/company-1/live-runs");
    const second = await request(app).get("/api/companies/company-1/live-runs");

    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
    expect(liveRunsCalls).toBe(1);
  });

  it("adds cache-control headers to protected polling endpoints", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: "company-1", agentId: "agent-1" };
      next();
    });
    app.use("/api", createPollingRateLimitAndCoalescingMiddleware({ requestsPerMinute: 100 }));
    app.get("/api/companies/company-1/dashboard", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/api/issues", (_req, res) => {
      res.json([]);
    });
    app.get("/api/heartbeat-runs/run-1/log", (_req, res) => {
      res.json({ log: "" });
    });

    const dashboardRes = await request(app).get("/api/companies/company-1/dashboard");
    const issuesRes = await request(app).get("/api/issues");
    const logsRes = await request(app).get("/api/heartbeat-runs/run-1/log");

    expect(dashboardRes.headers["cache-control"]).toBe("private, max-age=1, must-revalidate");
    expect(issuesRes.headers["cache-control"]).toBe("private, max-age=1, must-revalidate");
    expect(logsRes.headers["cache-control"]).toBe("private, max-age=1, must-revalidate");
  });
});
