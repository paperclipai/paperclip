import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { containerProbeRoutes } from "../routes/container-probe.js";

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: true,
  },
  probeFn?: () => Promise<{ ok: boolean; summary?: string; error?: string }>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  const router = containerProbeRoutes({ probe: probeFn ?? (async () => ({ ok: true, summary: "Docker 24.0.0" })) });
  app.use("/api", router);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as any).status ?? (err as any).statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

describe("GET /api/instance/container-engine/probe", () => {
  it("returns 200 ok:true when engine is reachable", async () => {
    const app = createApp(undefined, async () => ({ ok: true, summary: "Docker 24.0.0" }));
    const res = await request(app).get("/api/instance/container-engine/probe");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toBe("Docker 24.0.0");
  });

  it("returns 200 ok:false when engine is unreachable", async () => {
    const app = createApp(undefined, async () => ({ ok: false, error: "daemon not running" }));
    const res = await request(app).get("/api/instance/container-engine/probe");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("daemon");
  });

  it("returns 403 for non-instance-admin", async () => {
    const app = createApp({
      type: "board",
      userId: "user-2",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/instance/container-engine/probe");
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-board actors (agent/bearer)", async () => {
    const app = createApp({ type: "agent" });
    const res = await request(app).get("/api/instance/container-engine/probe");
    expect(res.status).toBe(403);
  });
});
