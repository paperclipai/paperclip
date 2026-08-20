import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createBackupOperationBarrier,
  createRestoreMaintenanceBarrier,
  createRestoreMaintenanceMcpBarrier,
  createRestoreMaintenancePreconditionBarrier,
} from "../app.js";

function createBarrierApp(
  state: { restore: boolean; snapshot: boolean },
  onAuthSideEffect: () => void = () => undefined,
  restoreMaintenanceMode = false,
  requireRestoreMaintenanceMode = false,
) {
  const app = express();
  app.use(express.json());
  if (restoreMaintenanceMode) {
    app.use("/api", createRestoreMaintenanceBarrier());
    app.use("/mcp", createRestoreMaintenanceMcpBarrier());
  } else if (requireRestoreMaintenanceMode) {
    app.use("/api", createRestoreMaintenancePreconditionBarrier());
  }
  app.use("/api", createBackupOperationBarrier({
    isRestoreRunning: () => state.restore,
    isSnapshotBarrierActive: () => state.snapshot,
  }));
  app.use("/mcp", createBackupOperationBarrier({
    isRestoreRunning: () => state.restore,
    isSnapshotBarrierActive: () => state.snapshot,
  }));
  // Represents actor middleware's API-key touch/audit writes. The app-level
  // barrier must short-circuit before it for every blocked request.
  app.use("/api", (_req, _res, next) => {
    onAuthSideEffect();
    next();
  });
  app.use("/mcp", (_req, _res, next) => {
    onAuthSideEffect();
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/get-session", (_req, res) => res.json({ session: null }));
  app.patch("/api/auth/profile", (_req, res) => res.status(204).end());
  app.post("/api/backups/run", (_req, res) => res.status(202).json({ started: true }));
  app.post("/api/backups/:backupId/restore", (_req, res) => res.status(202).json({ restoring: true }));
  app.post("/api/backups/recovery/rollback", (_req, res) => res.status(202).json({ rollingBack: true }));
  app.post("/mcp/gateways/test", (_req, res) => res.status(200).json({ invoked: true }));
  return app;
}

describe("backup operation API barrier", () => {
  it("blocks an auth mutation during snapshot capture while keeping get-session and backups available", async () => {
    const authSideEffect = vi.fn();
    const app = createBarrierApp({ restore: false, snapshot: true }, authSideEffect);

    await request(app).patch("/api/auth/profile").send({ name: "Changed" }).expect(503);
    expect(authSideEffect).not.toHaveBeenCalled();
    await request(app).get("/api/auth/get-session").expect(200, { session: null });
    await request(app).post("/api/backups/run").expect(202, { started: true });
  });

  it("blocks an auth mutation during restore while keeping health, get-session, and backups available", async () => {
    const authSideEffect = vi.fn();
    const app = createBarrierApp({ restore: true, snapshot: false }, authSideEffect);

    await request(app).patch("/api/auth/profile").send({ name: "Changed" }).expect(503);
    expect(authSideEffect).not.toHaveBeenCalled();
    await request(app).get("/api/health").expect(200, { ok: true });
    await request(app).get("/api/auth/get-session").expect(200, { session: null });
    await request(app).post("/api/backups/run").expect(202, { started: true });
  });

  it("blocks bearer-authenticated control routes before an auth side effect while an operation is active", async () => {
    for (const state of [
      { restore: false, snapshot: true },
      { restore: true, snapshot: false },
    ]) {
      const authSideEffect = vi.fn();
      const app = createBarrierApp(state, authSideEffect);

      await request(app)
        .get("/api/auth/get-session")
        .set("Authorization", "Bearer api-key-that-would-touch-state")
        .expect(503);
      expect(authSideEffect).not.toHaveBeenCalled();
    }
  });

  it("blocks MCP tool invocations during a consistency operation", async () => {
    for (const state of [
      { restore: false, snapshot: true },
      { restore: true, snapshot: false },
    ]) {
      const app = createBarrierApp(state);
      await request(app).post("/mcp/gateways/test").send({ method: "tools/call" }).expect(503);
    }
  });

  it("fails closed in restore maintenance mode before actor side effects", async () => {
    const authSideEffect = vi.fn();
    const app = createBarrierApp(
      { restore: false, snapshot: false },
      authSideEffect,
      true,
    );

    await request(app).patch("/api/auth/profile").send({ name: "Changed" }).expect(503);
    await request(app).post("/mcp/gateways/test").send({ method: "tools/call" }).expect(503);
    await request(app)
      .post("/api/backups/run")
      .set("Authorization", "Bearer api-key-that-would-touch-state")
      .expect(503);
    expect(authSideEffect).not.toHaveBeenCalled();

    await request(app).get("/api/health").expect(200, { ok: true });
    await request(app).get("/api/auth/get-session").expect(200, { session: null });
    await request(app).post("/api/backups/run").expect(202, { started: true });
    await request(app).post("/api/backups/backup-1/restore").expect(202, { restoring: true });
    await request(app).post("/api/backups/recovery/rollback").expect(202, { rollingBack: true });
  });

  it("requires startup-only maintenance mode for restore and rollback recovery", async () => {
    const authSideEffect = vi.fn();
    const app = createBarrierApp(
      { restore: false, snapshot: false },
      authSideEffect,
      false,
      true,
    );

    await request(app).post("/api/backups/backup-1/restore").expect(503);
    await request(app).post("/api/backups/recovery/rollback").expect(503);
    expect(authSideEffect).not.toHaveBeenCalled();
    await request(app).post("/api/backups/run").expect(202, { started: true });
  });
});
