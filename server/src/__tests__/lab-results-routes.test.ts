import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { labResultsRoutes } from "../routes/lab-results.js";
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
  app.use(labResultsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeLabResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "lr-1",
    companyId: "company-1",
    userId: "user-1",
    markerName: "HbA1c",
    loincCode: "4548-4",
    value: "5.2",
    unit: "%",
    optimalMin: "4.0",
    optimalMax: "5.6",
    measuredDate: "2026-09-01",
    source: "Quest",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /lab-results
// ---------------------------------------------------------------------------

describe("GET /lab-results", () => {
  it("returns lab results for the user (200)", async () => {
    const result = makeLabResult();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([result]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/lab-results?companyId=company-1&from=2025-09-01&to=2026-09-01",
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].markerName).toBe("HbA1c");
    expect(res.body.from).toBe("2025-09-01");
    expect(res.body.to).toBe("2026-09-01");
  });

  it("returns empty results array when none exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/lab-results?companyId=company-1&from=2025-09-01&to=2026-09-01",
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/lab-results?from=2025-09-01&to=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/lab-results?companyId=company-1&to=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/lab-results?companyId=company-1&from=2025-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/lab-results?companyId=company-1&from=2026-09-01&to=2025-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 730 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/lab-results?companyId=company-1&from=2024-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/lab-results?companyId=company-1&from=not-a-date&to=2026-09-01",
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
    app.use(labResultsRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/lab-results?companyId=company-1&from=2025-09-01&to=2026-09-01",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /lab-results
// ---------------------------------------------------------------------------

describe("POST /lab-results", () => {
  it("creates a lab result and returns 201", async () => {
    const result = makeLabResult();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([result]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/lab-results")
      .send({
        companyId: "company-1",
        measuredDate: "2026-09-01",
        markerName: "HbA1c",
        value: 5.2,
        unit: "%",
        loincCode: "4548-4",
        optimalMin: 4.0,
        optimalMax: 5.6,
        source: "Quest",
      });

    expect(res.status).toBe(201);
    expect(res.body.markerName).toBe("HbA1c");
    expect(res.body.unit).toBe("%");
  });

  it("creates a lab result without optional fields", async () => {
    const result = makeLabResult({ loincCode: null, optimalMin: null, optimalMax: null, source: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([result]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/lab-results")
      .send({
        companyId: "company-1",
        measuredDate: "2026-09-01",
        markerName: "Vitamin D (25-OH)",
        value: 42,
        unit: "ng/mL",
      });

    expect(res.status).toBe(201);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ measuredDate: "2026-09-01", markerName: "HbA1c", value: 5.2, unit: "%" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when measuredDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ companyId: "company-1", measuredDate: "bad-date", markerName: "HbA1c", value: 5.2, unit: "%" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when markerName is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ companyId: "company-1", measuredDate: "2026-09-01", value: 5.2, unit: "%" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when markerName is empty string", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ companyId: "company-1", measuredDate: "2026-09-01", markerName: "  ", value: 5.2, unit: "%" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ companyId: "company-1", measuredDate: "2026-09-01", markerName: "HbA1c", unit: "%" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when unit is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/lab-results")
      .send({ companyId: "company-1", measuredDate: "2026-09-01", markerName: "HbA1c", value: 5.2 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /lab-results/:id
// ---------------------------------------------------------------------------

describe("DELETE /lab-results/:id", () => {
  it("deletes the lab result and returns 204", async () => {
    const result = makeLabResult();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([result]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/lab-results/lr-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when lab result does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/lab-results/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when lab result belongs to a different user", async () => {
    const result = makeLabResult({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([result]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/lab-results/lr-1");
    expect(res.status).toBe(404);
  });
});
