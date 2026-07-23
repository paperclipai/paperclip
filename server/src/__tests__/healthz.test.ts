import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthzRoutes } from "../routes/healthz.js";
import { serverVersion } from "../version.js";

function createApp(db?: Db, opts: { port?: number } = {}) {
  const app = express();
  app.use("/healthz", healthzRoutes(db, opts));
  return app;
}

describe("GET /healthz", () => {
  const originalEnvPort = process.env.PAPERCLIP_LISTEN_PORT;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_LISTEN_PORT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnvPort === undefined) {
      delete process.env.PAPERCLIP_LISTEN_PORT;
    } else {
      process.env.PAPERCLIP_LISTEN_PORT = originalEnvPort;
    }
  });

  it("returns 200 with the minimal liveness shape when no db is wired", async () => {
    const app = createApp(undefined, { port: 4711 });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      version: serverVersion,
      port: 4711,
      dbReachable: true,
    });
    expect(typeof res.body.uptimeSec).toBe("number");
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db, { port: 4711 });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      ok: true,
      version: serverVersion,
      port: 4711,
      dbReachable: true,
    });
  });

  it("returns 503 with ok=false when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db, { port: 4711 });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      version: serverVersion,
      port: 4711,
      dbReachable: false,
    });
    expect(typeof res.body.uptimeSec).toBe("number");
  });

  it("falls back to PAPERCLIP_LISTEN_PORT env when no port opt is passed", async () => {
    process.env.PAPERCLIP_LISTEN_PORT = "5123";
    const app = createApp();

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.port).toBe(5123);
  });

  it("returns port=undefined when neither opt nor env are set", async () => {
    const app = createApp();

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    // JSON drops `undefined` keys — assert by absence rather than value.
    expect(res.body.port).toBeUndefined();
    expect(res.body).toMatchObject({
      ok: true,
      version: serverVersion,
      dbReachable: true,
    });
  });
});
