import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { biometricsRoutes } from "../routes/biometrics.js";
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
  app.use(biometricsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-08T00:00:00.000Z");

function makeReading(overrides: Record<string, unknown> = {}) {
  return {
    id: "reading-1",
    companyId: "company-1",
    userId: "user-1",
    measurementDate: "2026-09-08",
    weightKg: 75.5,
    systolicBp: 120,
    diastolicBp: 80,
    restingHeartRate: 62,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /biometrics
// ---------------------------------------------------------------------------

describe("GET /biometrics", () => {
  it("returns readings for the user (200)", async () => {
    const reading = makeReading();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([reading]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/biometrics?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.readings).toHaveLength(1);
    expect(res.body.readings[0].weightKg).toBe(75.5);
    expect(res.body.from).toBe("2026-09-01");
    expect(res.body.to).toBe("2026-09-08");
  });

  it("returns empty readings array when none exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/biometrics?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.readings).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/biometrics?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/biometrics?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/biometrics?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/biometrics?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/biometrics?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/biometrics?companyId=company-1&from=not-a-date&to=2026-09-08",
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
    app.use(biometricsRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/biometrics?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /biometrics
// ---------------------------------------------------------------------------

describe("POST /biometrics", () => {
  it("creates a reading with weight and returns 201", async () => {
    const reading = makeReading();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reading]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "2026-09-08", weightKg: 75.5 });

    expect(res.status).toBe(201);
    expect(res.body.weightKg).toBe(75.5);
  });

  it("creates a reading with blood pressure and heart rate", async () => {
    const reading = makeReading({ weightKg: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reading]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/biometrics")
      .send({
        companyId: "company-1",
        measurementDate: "2026-09-08",
        systolicBp: 120,
        diastolicBp: 80,
        restingHeartRate: 62,
      });

    expect(res.status).toBe(201);
  });

  it("upserts when the same date is posted twice", async () => {
    const reading = makeReading({ weightKg: 76.0 });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reading]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "2026-09-08", weightKg: 76.0 });

    expect(res.status).toBe(201);
    expect(res.body.weightKg).toBe(76.0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ measurementDate: "2026-09-08", weightKg: 75.5 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when measurementDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "bad-date", weightKg: 75.5 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when no measurement values are provided", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when weightKg is zero", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "2026-09-08", weightKg: 0 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when systolicBp is negative", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/biometrics")
      .send({ companyId: "company-1", measurementDate: "2026-09-08", systolicBp: -10 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /biometrics/:id
// ---------------------------------------------------------------------------

describe("DELETE /biometrics/:id", () => {
  it("deletes the reading and returns 204", async () => {
    const reading = makeReading();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([reading]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/biometrics/reading-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when reading does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/biometrics/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when reading belongs to a different user", async () => {
    const reading = makeReading({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([reading]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/biometrics/reading-1");
    expect(res.status).toBe(404);
  });
});
