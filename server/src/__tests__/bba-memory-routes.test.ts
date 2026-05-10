import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bba-memory-routes-"));
process.env.BBA_MEMORY_DIR = TMP_MEMORY_DIR;

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initBbaMemory, closeBbaMemory, getDb } from "../services/bba-memory/db.js";
import { startRun, completeRun } from "../services/bba-memory/index.js";

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { bbaMemoryRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/bba-memory.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-bbm",
      companyIds: ["company-bbm"],
      memberships: [{ companyId: "company-bbm", status: "active", membershipRole: "member" }],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", bbaMemoryRoutes());
  app.use(errorHandler);
  return app;
}

describe("bba-memory routes", () => {
  let app: express.Express;
  let adminApp: express.Express;

  beforeAll(async () => {
    initBbaMemory();
    [app, adminApp] = await Promise.all([
      createApp(),
      createApp({ isInstanceAdmin: true }),
    ]);
  });

  afterAll(() => {
    closeBbaMemory();
    fs.rmSync(TMP_MEMORY_DIR, { recursive: true, force: true });
    delete process.env.BBA_MEMORY_DIR;
  });

  // ── recent-runs: original 4 tests ─────────────────────────────────────────

  it("returns empty list when no runs", async () => {
    getDb().exec("DELETE FROM runs");
    const res = await request(app).get("/api/companies/company-bbm/bba-memory/recent-runs");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.runs).toEqual([]);
    expect(res.body.limit).toBe(20);
  });

  it("returns recent runs with correct shape", async () => {
    getDb().exec("DELETE FROM runs");
    const id1 = startRun({ source: "manual", trigger: "issue:I1" });
    completeRun(id1, { outcome: "success", meta: { companyId: "company-bbm" } });
    const id2 = startRun({ source: "manual", trigger: "issue:I2" });
    completeRun(id2, { outcome: "failure", failureClass: "UNKNOWN", meta: { companyId: "company-bbm" } });

    const res = await request(app).get("/api/companies/company-bbm/bba-memory/recent-runs?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(5);
    const outcomes = res.body.runs.map((r: any) => r.outcome).sort();
    expect(outcomes).toEqual(["failure", "success"]);
    const failureRow = res.body.runs.find((r: any) => r.outcome === "failure");
    expect(failureRow.failureClass).toBe("UNKNOWN");
  });

  it("clamps limit to safe range", async () => {
    const res = await request(app).get("/api/companies/company-bbm/bba-memory/recent-runs?limit=99999");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(20);
  });

  it("denies access for users without company access", async () => {
    const [{ errorHandler }, { bbaMemoryRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/bba-memory.js"),
    ]);
    const denyApp = express();
    denyApp.use(express.json());
    denyApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-other",
        companyIds: [],
        memberships: [],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    denyApp.use("/api", bbaMemoryRoutes());
    denyApp.use(errorHandler);

    const res = await request(denyApp).get("/api/companies/company-bbm/bba-memory/recent-runs");
    expect(res.status).toBe(403);
  });

  // ── recent-runs: 3 new hardening tests ────────────────────────────────────

  it("filters recent-runs by companyId (only returns matching company's runs)", async () => {
    getDb().exec("DELETE FROM runs");
    const a1 = startRun({ source: "manual", trigger: "issue:A1" });
    completeRun(a1, { outcome: "success", meta: { companyId: "company-bbm" } });
    const a2 = startRun({ source: "manual", trigger: "issue:A2" });
    completeRun(a2, { outcome: "failure", failureClass: "UNKNOWN", meta: { companyId: "company-bbm" } });
    const b1 = startRun({ source: "manual", trigger: "issue:B1" });
    completeRun(b1, { outcome: "success", meta: { companyId: "company-other" } });

    const res = await request(app).get("/api/companies/company-bbm/bba-memory/recent-runs");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.runs.every((r: any) => r.meta?.companyId === "company-bbm")).toBe(true);
  });

  it("recent-runs ?all=true is ignored for non-admin (returns company-filtered results)", async () => {
    getDb().exec("DELETE FROM runs");
    const a1 = startRun({ source: "manual", trigger: "issue:A1" });
    completeRun(a1, { outcome: "success", meta: { companyId: "company-bbm" } });
    const b1 = startRun({ source: "manual", trigger: "issue:B1" });
    completeRun(b1, { outcome: "success", meta: { companyId: "company-other" } });

    const res = await request(app).get("/api/companies/company-bbm/bba-memory/recent-runs?all=true");
    expect(res.status).toBe(200);
    // Non-admin: ?all=true ignored, only company-bbm runs returned
    expect(res.body.total).toBe(1);
  });

  it("recent-runs ?all=true returns all companies for instance admin", async () => {
    getDb().exec("DELETE FROM runs");
    const a1 = startRun({ source: "manual", trigger: "issue:A1" });
    completeRun(a1, { outcome: "success", meta: { companyId: "company-bbm" } });
    const b1 = startRun({ source: "manual", trigger: "issue:B1" });
    completeRun(b1, { outcome: "success", meta: { companyId: "company-other" } });

    const res = await request(adminApp).get("/api/companies/company-bbm/bba-memory/recent-runs?all=true");
    expect(res.status).toBe(200);
    // Admin: ?all=true returns all runs regardless of company
    expect(res.body.total).toBe(2);
  });

  // ── stats-summary: 3 new tests ────────────────────────────────────────────

  it("stats-summary returns zeroes and null successRatePct when no runs", async () => {
    getDb().exec("DELETE FROM runs");
    const res = await request(app).get("/api/companies/company-bbm/bba-memory/stats-summary");
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBe(0);
    expect(res.body.successRatePct).toBeNull();
    expect(res.body.topFailureClasses).toEqual([]);
    expect(res.body.windowDays).toBe(7);
  });

  it("stats-summary computes correct rates for mixed outcomes", async () => {
    getDb().exec("DELETE FROM runs");
    // 2 success + 1 failure + 1 partial = 4 total → successRatePct = 50.0
    const id1 = startRun({ source: "manual" });
    completeRun(id1, { outcome: "success", meta: { companyId: "company-bbm" } });
    const id2 = startRun({ source: "manual" });
    completeRun(id2, { outcome: "success", meta: { companyId: "company-bbm" } });
    const id3 = startRun({ source: "manual" });
    completeRun(id3, { outcome: "failure", failureClass: "UNKNOWN", meta: { companyId: "company-bbm" } });
    const id4 = startRun({ source: "manual" });
    completeRun(id4, { outcome: "partial", meta: { companyId: "company-bbm" } });

    const res = await request(app).get("/api/companies/company-bbm/bba-memory/stats-summary");
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBe(4);
    expect(res.body.successCount).toBe(2);
    expect(res.body.failureCount).toBe(1);
    expect(res.body.partialCount).toBe(1);
    expect(res.body.successRatePct).toBe(50.0);
    expect(res.body.topFailureClasses[0]).toEqual({ class: "UNKNOWN", count: 1 });
  });

  it("stats-summary clamps windowDays (999→90) and defaults invalid (0→7)", async () => {
    const res999 = await request(app).get("/api/companies/company-bbm/bba-memory/stats-summary?windowDays=999");
    expect(res999.status).toBe(200);
    expect(res999.body.windowDays).toBe(90);

    const res0 = await request(app).get("/api/companies/company-bbm/bba-memory/stats-summary?windowDays=0");
    expect(res0.status).toBe(200);
    expect(res0.body.windowDays).toBe(7);
  });
});
