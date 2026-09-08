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

// ---------------------------------------------------------------------------
// Location management
// ---------------------------------------------------------------------------

const NOW_LOC = new Date("2026-01-15T12:00:00.000Z");

function makeLocation(overrides: Record<string, unknown> = {}) {
  return {
    id: "loc-1",
    companyId: "company-1",
    userId: "user-1",
    lat: 37.7749,
    lng: -122.4194,
    label: "Home",
    isDefault: true,
    geohash: "9q8yy",
    createdAt: NOW_LOC,
    updatedAt: NOW_LOC,
    ...overrides,
  };
}

describe("GET /health/locations", () => {
  it("returns 403 when actor is not board", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db, agentActor());
    const res = await request(app).get("/health/locations?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations");
    expect(res.status).toBe(400);
  });

  it("returns saved locations for the user", async () => {
    const loc = makeLocation();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([loc]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0].label).toBe("Home");
  });

  it("returns empty list when no locations exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual([]);
  });
});

describe("POST /health/locations", () => {
  it("creates a location and returns 201", async () => {
    const loc = makeLocation();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([loc]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/health/locations")
      .send({ companyId: "company-1", lat: 37.7749, lng: -122.4194, label: "Home" });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("Home");
  });

  it("clears existing default when isDefault is true", async () => {
    const loc = makeLocation();
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: updateWhere }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([loc]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/health/locations")
      .send({ companyId: "company-1", lat: 37.7749, lng: -122.4194, isDefault: true });
    expect(res.status).toBe(201);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when lat is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/health/locations")
      .send({ companyId: "company-1", lng: -122.4194 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when lng is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/health/locations")
      .send({ companyId: "company-1", lat: 37.7749 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/health/locations")
      .send({ lat: 37.7749, lng: -122.4194 });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /health/locations/:id", () => {
  it("updates location label and returns updated row", async () => {
    const loc = makeLocation();
    const updated = { ...loc, label: "Work" };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([loc]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/health/locations/loc-1").send({ label: "Work" });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Work");
  });

  it("clears other defaults when setting isDefault to true", async () => {
    const loc = makeLocation({ isDefault: false });
    const updated = { ...loc, isDefault: true };
    const clearWhere = vi.fn().mockResolvedValue(undefined);
    let updateCallCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([loc]),
      update: vi.fn().mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 1) {
          return { set: vi.fn().mockReturnValue({ where: clearWhere }) };
        }
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updated]),
            }),
          }),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/health/locations/loc-1").send({ isDefault: true });
    expect(res.status).toBe(200);
    expect(clearWhere).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when location does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/health/locations/not-found").send({ label: "X" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when location belongs to a different user", async () => {
    const loc = makeLocation({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([loc]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/health/locations/loc-1").send({ label: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /health/locations/:id", () => {
  it("deletes location and returns 204", async () => {
    const loc = makeLocation();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([loc]),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).delete("/health/locations/loc-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when location does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).delete("/health/locations/not-found");
    expect(res.status).toBe(404);
  });

  it("returns 404 when location belongs to a different user", async () => {
    const loc = makeLocation({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([loc]),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).delete("/health/locations/loc-1");
    expect(res.status).toBe(404);
  });
});

describe("GET /health/locations/:id/readings", () => {
  it("returns 403 when actor is not board", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db, agentActor());
    const res = await request(app).get("/health/locations/loc-1/readings");
    expect(res.status).toBe(403);
  });

  it("returns readings for a location", async () => {
    const loc = makeLocation();
    const reading = {
      id: "reading-1",
      locationId: "loc-1",
      readingAt: NOW_LOC,
      aqi: 42,
      pm25: 10.5,
      pm10: 18.2,
      no2: 5.1,
      uvIndex: 3,
      landSurfaceTemp: 22.4,
      ndvi: 0.45,
      dataSource: "airnow",
      createdAt: NOW_LOC,
    };
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([loc]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([reading]),
              }),
            }),
          }),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations/loc-1/readings");
    expect(res.status).toBe(200);
    expect(res.body.readings).toHaveLength(1);
    expect(res.body.readings[0].aqi).toBe(42);
    expect(res.body.locationId).toBe("loc-1");
  });

  it("returns 404 when location does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations/not-found/readings");
    expect(res.status).toBe(404);
  });

  it("returns 404 when location belongs to a different user", async () => {
    const loc = makeLocation({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([loc]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations/loc-1/readings");
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid from parameter", async () => {
    const loc = makeLocation();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([loc]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations/loc-1/readings?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid to parameter", async () => {
    const loc = makeLocation();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([loc]),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/health/locations/loc-1/readings?to=bad");
    expect(res.status).toBe(400);
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
