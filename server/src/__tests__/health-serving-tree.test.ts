import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { healthRoutes } from "../routes/health.js";
import { __resetServingDriftCacheForTests, setCachedServingDrift } from "../serving-drift.js";

function appWith(opts: Parameters<typeof healthRoutes>[1]) {
  const app = express();
  app.use("/health", healthRoutes(undefined, opts));
  return app;
}

describe("GET /health servingTree (LOOA-389)", () => {
  const base = {
    deploymentMode: "local_trusted" as const,
    deploymentExposure: "private" as const,
    authReady: true,
    companyDeletionEnabled: true,
  };

  it("exposes the served commit when full details are shown", async () => {
    const app = appWith({ ...base, servingCommit: { head: "a".repeat(40), branch: "master" } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.servingTree).toEqual({ head: "a".repeat(40), branch: "master" });
  });

  it("omits servingTree entirely when the commit is unknown", async () => {
    const app = appWith({ ...base, servingCommit: null });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("servingTree");
  });

  it("does not leak the served commit to unauthenticated callers in authenticated mode", async () => {
    const app = appWith({
      ...base,
      deploymentMode: "authenticated",
      servingCommit: { head: "b".repeat(40), branch: "master" },
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    // No actor -> not full details -> served commit withheld, like `version`.
    expect(res.body).not.toHaveProperty("servingTree");
    expect(res.body).not.toHaveProperty("version");
  });
});

describe("GET /health servingTree.behindBy (LOOA-412)", () => {
  const base = {
    deploymentMode: "local_trusted" as const,
    deploymentExposure: "private" as const,
    authReady: true,
    companyDeletionEnabled: true,
  };
  const head = "c".repeat(40);

  afterEach(() => {
    __resetServingDriftCacheForTests();
  });

  it("enriches servingTree with cached drift when the cache head matches the served head", async () => {
    setCachedServingDrift({
      head,
      branch: "master",
      behindBy: 3,
      stale: true,
      driftAgeMs: 42_000,
      checkedAtMs: 1_000,
    });
    const app = appWith({ ...base, servingCommit: { head, branch: "master" } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.servingTree).toEqual({
      head,
      branch: "master",
      behindBy: 3,
      stale: true,
      driftCheckedAtMs: 1_000,
    });
  });

  it("reports head/branch alone (no stale behindBy) when the cache lags the served head", async () => {
    // A deploy advanced the served head but the sweep has not recomputed yet:
    // the cache still describes the old head, so behindBy must be withheld.
    setCachedServingDrift({
      head: "d".repeat(40),
      branch: "master",
      behindBy: 5,
      stale: true,
      driftAgeMs: 99_000,
      checkedAtMs: 2_000,
    });
    const app = appWith({ ...base, servingCommit: { head, branch: "master" } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.servingTree).toEqual({ head, branch: "master" });
    expect(res.body.servingTree).not.toHaveProperty("behindBy");
  });
});
