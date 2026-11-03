import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { livenessRoutes } from "../routes/liveness.js";
import { readinessRoutes } from "../routes/ready.js";
import { healthRoutes } from "../routes/health.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";
import { cloudRuntimeIdentityMiddleware } from "../middleware/cloud-runtime-identity.js";
import { cloudWarmStandbyMiddleware } from "../middleware/cloud-warm-standby.js";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { resetStartupRecoveryStateForTests, setStartupRecoveryPhase } from "../startup-recovery-state.js";
import { getServerInfoSnapshot } from "../server-info.js";

afterEach(() => { stopTaskDrain(); resetStartupRecoveryStateForTests(); });

function fixture(standby = false) {
  const db = { execute: vi.fn().mockRejectedValue(new Error("database offline")) } as unknown as Db;
  const auth = vi.fn((_req, _res, next) => next());
  const health = healthRoutes(db, {
    deploymentMode: "authenticated", deploymentExposure: "public", authReady: true,
    companyDeletionEnabled: false, runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "fixture-token" },
    isWarmStandby: () => standby,
  });
  const app = express();
  app.use(idleAdmissionMiddleware);
  app.use(privateHostnameGuard({ enabled: true, allowedHostnames: ["allowed.example"], bindHost: "0.0.0.0" }));
  app.use(cloudRuntimeIdentityMiddleware(db));
  app.use("/api/liveness", livenessRoutes());
  app.use("/api/ready", readinessRoutes());
  app.use(cloudWarmStandbyMiddleware(() => standby, health));
  app.use(auth);
  app.use("/api/health", health);
  app.get("/api/private", (_req, res) => res.sendStatus(401));
  trackIdleRequestHandlers(app);
  const http = request.agent(app).set("host", "allowed.example");
  return { app, http, db, auth };
}

describe("database-free process liveness", () => {
  it.each([false, true])("gates deployment readiness on bootstrap and drain without waking SQL (standby: %s)", async standby => {
    const f = fixture(standby);
    const before = idleWorkSnapshot();
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    for (const phase of ["starting", "recovering", "ready", "draining"] as const) {
      setStartupRecoveryPhase(phase);
      const status = phase === "ready" ? 200 : 503;
      const response = await f.http.get("/api/ready").set("authorization", "Bearer invalid-fixture").expect(status);
      expect(response.body).toEqual({ status: phase });
      expect(response.headers["cache-control"]).toBe("no-store");
      await f.http.head("/api/ready").expect(status);
    }
    await f.http.post("/api/ready").expect(503);
    await f.http.get("/api/ready/details").expect(503);
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(idleWorkSnapshot()).toEqual(before);
  });
  it.each([false, true])("does not resolve auth or query SQL with an unavailable database (standby: %s)", async standby => {
    const f = fixture(standby);
    for (let i = 0; i < 3; i++) {
      const response = await f.http.get("/api/liveness")
        .set("authorization", "Bearer invalid-fixture")
        .set("cookie", "session_token=invalid-fixture")
        .set("x-paperclip-cloud-tenant-token", "invalid-fixture");
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const serverInfo = getServerInfoSnapshot();
      expect(response.body).toEqual({ status: "ok", commit: serverInfo.git.available ? serverInfo.git.fullSha : null });
    }
    const head = await f.http.head("/api/liveness").expect(200);
    expect(head.text).toBeUndefined();
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    if (!standby) {
      await f.http.get("/api/health").expect(503);
      expect(f.db.execute).toHaveBeenCalledOnce();
      await f.http.get("/api/private").expect(401);
      expect(f.auth).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["starting", "recovering"] as const)("reports %s until startup recovery is complete", async phase => {
    const f = fixture();
    setStartupRecoveryPhase(phase);
    await f.http.get("/api/liveness").expect(503).expect(response => expect(response.body.status).toBe("starting"));
    setStartupRecoveryPhase("ready");
    await f.http.get("/api/liveness").expect(200);
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it("retains hostname and signed bootstrap endpoint validation", async () => {
    const f = fixture();
    await f.http.get("/api/liveness").set("host", "denied.example").expect(403);
    await f.http.get("/api/liveness").set("x-paperclip-cloud-runtime-identity", "invalid-fixture")
      .expect(400).expect({ error: "cloud_runtime_identity_wrong_endpoint" });
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it("stays reachable during drain without exempting writes or other paths", async () => {
    const f = fixture();
    const before = idleWorkSnapshot();
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    for (const path of ["/api/liveness", "/api/liveness/"]) {
      await f.http.get(path).expect(200);
      await f.http.head(path).expect(200);
      await f.http.post(path).expect(503);
    }
    await f.http.get("/api/liveness/details").expect(503);
    await f.http.get("/api/private").expect(503);
    expect(idleWorkSnapshot()).toEqual(before);
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it("mounts the production route after host and bootstrap validation and before standby/auth", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const route = source.indexOf('app.use("/api/liveness", livenessRoutes())');
    expect(route).toBeGreaterThan(source.indexOf("privateHostnameGuard({"));
    expect(route).toBeGreaterThan(source.indexOf("app.use(cloudRuntimeIdentityMiddleware(db))"));
    expect(route).toBeLessThan(source.indexOf("app.use(cloudWarmStandbyMiddleware("));
    expect(route).toBeLessThan(source.indexOf("actorMiddleware(db,"));
  });
});
