import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { exerciseRoutes } from "../routes/exercise.js";
import { errorHandler } from "../middleware/error-handler.js";

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor();
    next();
  });
  app.use(exerciseRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    companyId: "company-1",
    userId: "user-1",
    exerciseDate: "2026-09-08",
    activityType: "running",
    durationMinutes: 30,
    intensityLevel: "moderate",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /exercise
// ---------------------------------------------------------------------------

describe("GET /exercise", () => {
  it("returns exercise logs for the user (200)", async () => {
    const log = makeLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/exercise?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].activityType).toBe("running");
    expect(res.body.from).toBe("2026-09-01");
    expect(res.body.to).toBe("2026-09-08");
  });

  it("returns empty logs array when none exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/exercise?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/exercise?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/exercise?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/exercise?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/exercise?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/exercise?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/exercise?companyId=company-1&from=not-a-date&to=2026-09-08",
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when actor is not board", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent" as const, agentId: "agent-1", companyId: "company-1" };
      next();
    });
    app.use(exerciseRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/exercise?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /exercise
// ---------------------------------------------------------------------------

describe("POST /exercise", () => {
  it("creates an exercise log and returns 201", async () => {
    const log = makeLog();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/exercise")
      .send({
        companyId: "company-1",
        exerciseDate: "2026-09-08",
        activityType: "running",
        durationMinutes: 30,
        intensityLevel: "moderate",
      });

    expect(res.status).toBe(201);
    expect(res.body.activityType).toBe("running");
    expect(res.body.durationMinutes).toBe(30);
  });

  it("allows multiple logs for the same date", async () => {
    const log = makeLog({ activityType: "yoga" });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/exercise")
      .send({
        companyId: "company-1",
        exerciseDate: "2026-09-08",
        activityType: "yoga",
        durationMinutes: 45,
      });

    expect(res.status).toBe(201);
    expect(res.body.activityType).toBe("yoga");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/exercise")
      .send({ exerciseDate: "2026-09-08", activityType: "running", durationMinutes: 30 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when exerciseDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/exercise")
      .send({ companyId: "company-1", exerciseDate: "bad-date", activityType: "running", durationMinutes: 30 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when activityType is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/exercise")
      .send({ companyId: "company-1", exerciseDate: "2026-09-08", activityType: "dancing", durationMinutes: 30 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when durationMinutes is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/exercise")
      .send({ companyId: "company-1", exerciseDate: "2026-09-08", activityType: "running" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when durationMinutes is zero", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/exercise")
      .send({ companyId: "company-1", exerciseDate: "2026-09-08", activityType: "running", durationMinutes: 0 });
    expect(res.status).toBe(400);
  });

  it("ignores an unknown intensityLevel and stores null", async () => {
    const log = makeLog({ intensityLevel: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/exercise")
      .send({
        companyId: "company-1",
        exerciseDate: "2026-09-08",
        activityType: "running",
        durationMinutes: 30,
        intensityLevel: "extreme",
      });

    expect(res.status).toBe(201);
    expect(res.body.intensityLevel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /exercise/:id
// ---------------------------------------------------------------------------

describe("DELETE /exercise/:id", () => {
  it("deletes the exercise log and returns 204", async () => {
    const log = makeLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/exercise/log-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when exercise log does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/exercise/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when exercise log belongs to a different user", async () => {
    const log = makeLog({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/exercise/log-1");
    expect(res.status).toBe(404);
  });
});
