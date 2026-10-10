import { createServer, request as httpRequest } from "node:http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { cloudWarmStandbyMiddleware, cloudWarmStandbyServerOptions } from "../middleware/cloud-warm-standby.js";
import { healthRoutes } from "../routes/health.js";
import { emailChannelService } from "../services/email-channels.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { createPublicMcpEvents } from "../services/public-mcp/events.js";
import type { PublicMcpOAuth } from "../services/public-mcp/oauth.js";

const healthOptions = {
  deploymentMode: "authenticated" as const,
  deploymentExposure: "public" as const,
  authReady: true,
  companyDeletionEnabled: false,
  runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-token" },
};
afterEach(() => vi.useRealTimers());

describe("unclaimed Cloud background work", () => {
  it("keeps probes and tenant requests out of SQL and auth until claim", async () => {
    let standby = true;
    const execute = vi.fn().mockResolvedValue([]);
    const db = { execute } as unknown as Db;
    const health = healthRoutes(db, { ...healthOptions, isWarmStandby: () => standby });
    const app = express();
    const auth = vi.fn((_req, _res, next) => next());
    const ui = express.Router();
    ui.get("/", (_req, res) => res.type("html").send("ready"));
    ui.get("/assets/app.js", (_req, res) => res.type("js").send("ready"));
    app.use(cloudWarmStandbyMiddleware(() => standby, health, ui));
    app.use(auth);
    app.use("/api/health", health);
    app.get("/api/companies", (_req, res) => res.json([]));
    for (let i = 0; i < 3; i++) {
      const probe = await request(app).get("/api/health").set("authorization", "Bearer ignored-in-standby");
      expect(probe.status).toBe(200);
      expect(probe.body.warmStandby).toBe(true);
      expect(probe.body.serverInfo).toBeUndefined();
    }
    expect((await request(app).head("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/companies")).status).toBe(503);
    expect((await request(app).post("/api/health/dev-server/restart")).status).toBe(503);
    for (const path of ["/", "/assets/app.js"]) {
      const page = await request(app).get(path)
        .set("authorization", "Bearer test-bearer")
        .set("x-paperclip-cloud-tenant-token", "test-tenant")
        .set("cookie", "paperclip.session_token=test-session");
      expect(page.status).toBe(200);
    }
    expect((await request(app).post("/mcp/gateways/gw_test")).status).toBe(503);
    expect((await request(app).get("/unknown-dynamic-handler")).status).toBe(503);
    expect(auth).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    standby = false;
    expect((await request(app).get("/api/companies")).status).toBe(200);
    const claimed = await request(app).get("/api/health");
    expect(claimed.status).toBe(200);
    expect(claimed.body.warmStandby).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    execute.mockRejectedValueOnce(new Error("offline"));
    expect((await request(app).get("/api/health")).status).toBe(503);
  });

  it("rejects every WebSocket upgrade before auth and admits upgrades after claim", async () => {
    let standby = true;
    const app = express();
    const health = healthRoutes({} as Db, { ...healthOptions, isWarmStandby: () => standby });
    const authenticate = vi.fn();
    app.use(cloudWarmStandbyMiddleware(() => standby, health));
    const server = createServer(cloudWarmStandbyServerOptions(() => standby), app);
    server.on("upgrade", (_req, socket) => {
      authenticate();
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const upgrade = (path: string) => new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1", port: address.port, path,
        headers: { connection: "Upgrade", upgrade: "websocket", authorization: "Bearer test-bearer" },
      });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end();
    });
    try {
      for (const path of ["/api/companies/company/events/ws?token=anything", "/api/health", "/prp", "/"]) {
        expect(await upgrade(path)).toBe(503);
      }
      expect(authenticate).not.toHaveBeenCalled();
      standby = false;
      expect(await upgrade("/api/companies/company/events/ws?token=anything")).toBe(101);
      expect(authenticate).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("MCP event timers do not read the persisted setting until claim", async () => {
    vi.useFakeTimers();
    let standby = true;
    const isEnabled = vi.fn().mockResolvedValue(false);
    const events = createPublicMcpEvents({} as Db, { isEnabled } as PublicMcpOAuth, vi.fn(), {
      isBackgroundWorkEnabled: () => !standby,
    });
    try {
      events.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await events.tick();
      expect(isEnabled).not.toHaveBeenCalled();
      standby = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(isEnabled).toHaveBeenCalledOnce();
    } finally {
      await events.stop();
    }
  });

  it("email and plugin timers leave SQL idle, then resume without restarting", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const select = vi.fn(() => { throw new Error("SQL probe"); });
    const db = installDatabaseWorkSignals({ select, execute: vi.fn(), transaction: vi.fn() }) as unknown as Db;
    const email = emailChannelService(db, { heartbeat: { wakeup: vi.fn() }, isBackgroundWorkEnabled: () => enabled });
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: {} as never,
      workerManager: {} as never,
      tickIntervalMs: 1000,
      isBackgroundWorkEnabled: () => enabled,
    });
    try {
      email.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(select).not.toHaveBeenCalled();
      enabled = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(select.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      scheduler.stop();
      await email.shutdown();
    }
  });
});
