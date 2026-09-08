import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { nutritionRoutes } from "../routes/nutrition.js";
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
  app.use(nutritionRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-08T00:00:00.000Z");

function makeNutritionLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "nutrition-1",
    companyId: "company-1",
    userId: "user-1",
    logDate: "2026-09-08",
    waterMl: 2000,
    calories: 1800,
    proteinG: 120,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /nutrition
// ---------------------------------------------------------------------------

describe("GET /nutrition", () => {
  it("returns nutrition logs for the user (200)", async () => {
    const log = makeNutritionLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/nutrition?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].waterMl).toBe(2000);
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
      "/nutrition?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/nutrition?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/nutrition?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/nutrition?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/nutrition?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/nutrition?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/nutrition?companyId=company-1&from=not-a-date&to=2026-09-08",
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
    app.use(nutritionRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/nutrition?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /nutrition
// ---------------------------------------------------------------------------

describe("POST /nutrition", () => {
  it("creates a nutrition log and returns 201", async () => {
    const log = makeNutritionLog();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: 2000, calories: 1800 });

    expect(res.status).toBe(201);
    expect(res.body.waterMl).toBe(2000);
    expect(res.body.calories).toBe(1800);
  });

  it("upserts when the same date is posted twice", async () => {
    const log = makeNutritionLog({ waterMl: 2500 });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: 2500 });

    expect(res.status).toBe(201);
    expect(res.body.waterMl).toBe(2500);
  });

  it("accepts a log with only waterMl (calories/proteinG optional)", async () => {
    const log = makeNutritionLog({ calories: null, proteinG: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: 1500 });

    expect(res.status).toBe(201);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ logDate: "2026-09-08", waterMl: 2000 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when logDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "bad-date", waterMl: 2000 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when waterMl is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when waterMl is negative", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: -100 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when calories is negative", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: 2000, calories: -50 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when proteinG is negative", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/nutrition")
      .send({ companyId: "company-1", logDate: "2026-09-08", waterMl: 2000, proteinG: -10 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /nutrition/:id
// ---------------------------------------------------------------------------

describe("DELETE /nutrition/:id", () => {
  it("deletes the nutrition log and returns 204", async () => {
    const log = makeNutritionLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/nutrition/nutrition-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when nutrition log does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/nutrition/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when nutrition log belongs to a different user", async () => {
    const log = makeNutritionLog({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/nutrition/nutrition-1");
    expect(res.status).toBe(404);
  });
});
