import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthGoalsRoutes } from "../routes/health-goals.js";
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
  app.use(healthGoalsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-08T00:00:00.000Z");

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    companyId: "company-1",
    userId: "user-1",
    goalType: "water_ml",
    targetValue: 2500,
    unit: "ml",
    label: "Daily water intake",
    isActive: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /health/goals
// ---------------------------------------------------------------------------

describe("GET /health/goals", () => {
  it("returns active goals for the user (200)", async () => {
    const goal = makeGoal();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/health/goals?companyId=company-1")
      .expect(200);

    expect(res.body.goals).toHaveLength(1);
    expect(res.body.goals[0].goalType).toBe("water_ml");
  });

  it("returns empty array when no goals exist (200)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/health/goals?companyId=company-1")
      .expect(200);

    expect(res.body.goals).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db)).get("/health/goals").expect(400);
  });

  it("returns 403 when actor is not board type", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent" as const, agentId: "agent-1", companyId: "company-1" };
      next();
    });
    app.use(healthGoalsRoutes({} as unknown as Db));
    app.use(errorHandler);
    await request(app).get("/health/goals?companyId=company-1").expect(403);
  });
});

// ---------------------------------------------------------------------------
// POST /health/goals
// ---------------------------------------------------------------------------

describe("POST /health/goals", () => {
  it("creates a new health goal (201)", async () => {
    const goal = makeGoal();
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/health/goals")
      .send({
        companyId: "company-1",
        goalType: "water_ml",
        targetValue: 2500,
        unit: "ml",
        label: "Daily water intake",
      })
      .expect(201);

    expect(res.body.goalType).toBe("water_ml");
    expect(res.body.targetValue).toBe(2500);
  });

  it("deactivates existing goal of same type before inserting", async () => {
    const goal = makeGoal();
    const updateWhere = vi.fn().mockResolvedValue([]);
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: updateWhere,
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    await request(createApp(db))
      .post("/health/goals")
      .send({
        companyId: "company-1",
        goalType: "water_ml",
        targetValue: 3000,
        unit: "ml",
        label: "Updated target",
      })
      .expect(201);

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("accepts optional notes field", async () => {
    const goal = makeGoal({ notes: "stay hydrated" });
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/health/goals")
      .send({
        companyId: "company-1",
        goalType: "water_ml",
        targetValue: 2500,
        unit: "ml",
        label: "Daily water intake",
        notes: "stay hydrated",
      })
      .expect(201);

    expect(res.body.notes).toBe("stay hydrated");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db))
      .post("/health/goals")
      .send({ goalType: "water_ml", targetValue: 2500, unit: "ml", label: "x" })
      .expect(400);
  });

  it("returns 400 when goalType is invalid", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db))
      .post("/health/goals")
      .send({ companyId: "company-1", goalType: "invalid_type", targetValue: 10, unit: "x", label: "x" })
      .expect(400);
  });

  it("returns 400 when targetValue is not a positive integer", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db))
      .post("/health/goals")
      .send({ companyId: "company-1", goalType: "water_ml", targetValue: -5, unit: "ml", label: "x" })
      .expect(400);
  });

  it("returns 400 when unit is missing", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db))
      .post("/health/goals")
      .send({ companyId: "company-1", goalType: "water_ml", targetValue: 2500, label: "x" })
      .expect(400);
  });

  it("returns 400 when label is missing", async () => {
    const db = {} as unknown as Db;
    await request(createApp(db))
      .post("/health/goals")
      .send({ companyId: "company-1", goalType: "water_ml", targetValue: 2500, unit: "ml" })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /health/goals/:id
// ---------------------------------------------------------------------------

describe("PATCH /health/goals/:id", () => {
  it("updates targetValue and returns updated goal (200)", async () => {
    const goal = makeGoal();
    const updated = makeGoal({ targetValue: 3000 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn()
        .mockResolvedValueOnce([goal])
        .mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/health/goals/goal-1")
      .send({ targetValue: 3000 })
      .expect(200);

    expect(res.body.targetValue).toBe(3000);
  });

  it("returns 404 when goal does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    await request(createApp(db))
      .patch("/health/goals/nonexistent")
      .send({ targetValue: 3000 })
      .expect(404);
  });

  it("returns 404 when goal belongs to another user", async () => {
    const goal = makeGoal({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    await request(createApp(db))
      .patch("/health/goals/goal-1")
      .send({ targetValue: 3000 })
      .expect(404);
  });

  it("returns 400 when targetValue is zero", async () => {
    const goal = makeGoal();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    await request(createApp(db))
      .patch("/health/goals/goal-1")
      .send({ targetValue: 0 })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /health/goals/:id
// ---------------------------------------------------------------------------

describe("DELETE /health/goals/:id", () => {
  it("soft-deletes a goal (204)", async () => {
    const goal = makeGoal();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn()
        .mockResolvedValueOnce([goal])
        .mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    } as unknown as Db;

    await request(createApp(db)).delete("/health/goals/goal-1").expect(204);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when goal does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    await request(createApp(db)).delete("/health/goals/nonexistent").expect(404);
  });

  it("returns 404 when goal belongs to another user", async () => {
    const goal = makeGoal({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([goal]),
    } as unknown as Db;

    await request(createApp(db)).delete("/health/goals/goal-1").expect(404);
  });
});
