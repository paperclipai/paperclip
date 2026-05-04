import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthLongevityRoutes } from "../routes/health-longevity.js";
import { errorHandler } from "../middleware/error-handler.js";

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function agentActor(companyId = "company-1") {
  return {
    type: "agent" as const,
    agentId: "agent-1",
    companyId,
    runId: null,
  };
}

function createApp(db: Db, actor?: object) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (actor ?? boardActor()) as any;
    next();
  });
  app.use("/health", healthLongevityRoutes(db));
  app.use(errorHandler);
  return app;
}

function makeDb(selectResult: unknown[] = []) {
  const resolved = Promise.resolve(selectResult);
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(() => Object.assign(resolved, chain)),
    limit: vi.fn().mockResolvedValue(selectResult),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  return { select: vi.fn(() => chain) } as unknown as Db;
}

describe("GET /health/environmental-score", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb([]);
  });

  it("returns 403 when actor is not board", async () => {
    const app = createApp(db, agentActor());
    const res = await request(app).get("/health/environmental-score?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when companyId is missing", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score");
    expect(res.status).toBe(400);
  });

  it("returns 403 when board user does not have access to the company", async () => {
    const actor = {
      type: "board" as const,
      source: "session" as const,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["other-company"],
    };
    const app = createApp(db, actor);
    const res = await request(app).get("/health/environmental-score?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 200 with today and history when data exists", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const yesterday = new Date("2026-01-14T12:00:00.000Z");
    const rows = [
      {
        overallScore: 82,
        colorTier: "green",
        scoredAt: now,
        confidenceFlag: null,
        partialSignals: [],
        aqiComponent: 90,
        uvComponent: 75,
        heatStressComponent: 80,
        greenspaceComponent: 85,
      },
      {
        overallScore: 78,
        colorTier: "yellow",
        scoredAt: yesterday,
        confidenceFlag: "low_signals",
        partialSignals: ["uv"],
        aqiComponent: null,
        uvComponent: null,
        heatStressComponent: null,
        greenspaceComponent: null,
      },
    ];
    db = makeDb(rows);
    const app = createApp(db);
    const res = await request(app)
      .get("/health/environmental-score?companyId=company-1&userId=user-1");
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({ score: 82, colorTier: "green" });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.disclaimer).toBeTruthy();
  });

  it("returns null today when no scores exist", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.today).toBeNull();
    expect(res.body.history).toEqual([]);
  });
});

describe("GET /health/environmental-score/map", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb([]);
  });

  it("returns 403 when actor is not board", async () => {
    const app = createApp(db, agentActor());
    const res = await request(app).get("/health/environmental-score/map?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when companyId is missing", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score/map");
    expect(res.status).toBe(400);
  });

  it("returns 403 when board user does not have access to the company", async () => {
    const actor = {
      type: "board" as const,
      source: "session" as const,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["other-company"],
    };
    const app = createApp(db, actor);
    const res = await request(app).get("/health/environmental-score/map?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid date parameter", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score/map?companyId=company-1&date=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 200 with empty points when no data", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score/map?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.disclaimer).toBeTruthy();
  });

  it("returns 200 with map points when data exists", async () => {
    const now = new Date("2026-01-15T10:00:00.000Z");
    const rows = [
      { lat: "37.7749", lng: "-122.4194", geohash: "9q8yy", overallScore: 80, colorTier: "green", scoredAt: now },
      { lat: "37.7800", lng: "-122.4100", geohash: "9q8yz", overallScore: 65, colorTier: "yellow", scoredAt: now },
    ];
    db = makeDb(rows);
    const app = createApp(db);
    const res = await request(app).get("/health/environmental-score/map?companyId=company-1&date=2026-01-15");
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[0]).toMatchObject({ lat: "37.7749", lng: "-122.4194", score: 80 });
    expect(res.body.date).toBe("2026-01-15");
  });
});
