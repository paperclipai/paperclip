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

async function createApp() {
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
    };
    next();
  });
  app.use("/api", bbaMemoryRoutes());
  app.use(errorHandler);
  return app;
}

describe("bba-memory routes", () => {
  let app: express.Express;

  beforeAll(async () => {
    initBbaMemory();
    app = await createApp();
  });

  afterAll(() => {
    closeBbaMemory();
    fs.rmSync(TMP_MEMORY_DIR, { recursive: true, force: true });
    delete process.env.BBA_MEMORY_DIR;
  });

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
});
