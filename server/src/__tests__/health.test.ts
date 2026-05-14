import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import { errorHandler } from "../middleware/index.js";

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db_ok: true });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unhealthy", db_ok: false });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const authedApp = express();
    authedApp.use((req: any, _res, next) => { req.actor = { type: "none" }; next(); });
    authedApp.use("/health", healthRoutes(undefined, { deploymentMode: "authenticated", deploymentExposure: "private" }));
    authedApp.use(errorHandler);

    const res = await request(authedApp).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unhealthy" });
    expect(res.body.uptime).toBeUndefined();
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const app = express();
    app.use("/health", healthRoutes(undefined, { deploymentMode: "authenticated", deploymentExposure: "private" }));
    app.use(errorHandler);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unhealthy" });
    expect(res.body.uptime).toBeUndefined();
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const authedApp = express();
    authedApp.use((req: any, _res, next) => { req.actor = { type: "board" }; next(); });
    authedApp.use("/health", healthRoutes(undefined, { deploymentMode: "authenticated", deploymentExposure: "private" }));
    authedApp.use(errorHandler);

    const res = await request(authedApp).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unhealthy" });
    expect(typeof res.body.uptime).toBe("number");
  });

  it("serves /healthz with required fields", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      db_ok: true,
    });
    expect(typeof res.body.uptime).toBe("number");
    expect(typeof res.body.open_connections).toBe("number");
    expect(typeof res.body.log_size_mb).toBe("number");
    expect(typeof res.body.memory_mb).toBe("number");
  });

  it("serves /metrics in Prometheus text format", async () => {
    const app = createApp();
    const res = await request(app).get("/health/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("requests_total");
    expect(res.text).toContain("request_duration_seconds");
    expect(res.text).toContain("open_connections");
    expect(res.text).toContain("event_loop_lag_ms");
    expect(res.text).toContain("log_size_mb");
  });
});
