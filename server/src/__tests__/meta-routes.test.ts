import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMetaCatalog } from "../routes/meta.js";

function buildAppWithSampleRoutes(opts?: { gitSha?: string | null }) {
  const app = express();
  app.use(express.json());
  const api = Router();
  const catalog = createMetaCatalog({ gitSha: opts?.gitSha ?? null });
  catalog.install(api, "/api");

  // No-op middleware should not appear in the catalog.
  api.use((_req, _res, next) => next());

  const health = Router();
  health.get("/", (_req, res) => res.json({ ok: true }));
  api.use("/health", health);

  const issues = Router();
  issues.get("/issues/:issueId", (_req, res) => res.json({}));
  issues.post("/issues/:issueId/checkout", (_req, res) => res.json({}));
  issues.patch("/issues/:issueId", (_req, res) => res.json({}));
  api.use(issues);

  api.use(catalog.router());
  app.use("/api", api);
  return { app, catalog };
}

describe("GET /api/_meta", () => {
  it("returns server version and an enumerated route catalog", async () => {
    const { app } = buildAppWithSampleRoutes({ gitSha: "abc123" });
    const res = await request(app).get("/api/_meta");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gitSha: "abc123",
    });
    expect(typeof res.body.serverVersion).toBe("string");
    expect(res.body.serverVersion.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.routes)).toBe(true);

    const routeSet = new Set(
      (res.body.routes as Array<{ method: string; path: string }>).map(
        (r) => `${r.method} ${r.path}`,
      ),
    );
    expect(routeSet.has("GET /api/health/")).toBe(true);
    expect(routeSet.has("GET /api/issues/:issueId")).toBe(true);
    expect(routeSet.has("POST /api/issues/:issueId/checkout")).toBe(true);
    expect(routeSet.has("PATCH /api/issues/:issueId")).toBe(true);
    expect(routeSet.has("GET /api/_meta")).toBe(true);
  });

  it("defaults gitSha to null when none is supplied", async () => {
    const prev = process.env.PAPERCLIP_GIT_SHA;
    delete process.env.PAPERCLIP_GIT_SHA;
    try {
      const { app } = buildAppWithSampleRoutes();
      const res = await request(app).get("/api/_meta");
      expect(res.status).toBe(200);
      expect(res.body.gitSha).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PAPERCLIP_GIT_SHA = prev;
    }
  });

  it("falls back to PAPERCLIP_GIT_SHA env when option not provided", async () => {
    const prev = process.env.PAPERCLIP_GIT_SHA;
    process.env.PAPERCLIP_GIT_SHA = "envsha";
    try {
      const app = express();
      const api = Router();
      const catalog = createMetaCatalog();
      catalog.install(api, "/api");
      api.use(catalog.router());
      app.use("/api", api);
      const res = await request(app).get("/api/_meta");
      expect(res.status).toBe(200);
      expect(res.body.gitSha).toBe("envsha");
    } finally {
      if (prev === undefined) delete process.env.PAPERCLIP_GIT_SHA;
      else process.env.PAPERCLIP_GIT_SHA = prev;
    }
  });

  it("deduplicates and sorts the route catalog", async () => {
    const app = express();
    const api = Router();
    const catalog = createMetaCatalog();
    catalog.install(api, "/api");
    const sub = Router();
    sub.get("/zeta", (_req, res) => res.json({}));
    sub.get("/alpha", (_req, res) => res.json({}));
    api.use(sub);
    // Mount the same router twice to verify dedup
    api.use(sub);
    api.use(catalog.router());
    app.use("/api", api);
    const res = await request(app).get("/api/_meta");
    const paths = (res.body.routes as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(["/api/_meta", "/api/alpha", "/api/zeta"]);
  });
});
