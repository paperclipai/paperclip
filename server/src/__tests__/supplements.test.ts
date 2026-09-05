import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { supplementsRoutes } from "../routes/supplements.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  app.use(supplementsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeSupplement(overrides: Record<string, unknown> = {}) {
  return {
    id: "sup-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Vitamin D",
    dose: "2000",
    unit: "IU",
    scheduledTime: "08:00",
    active: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeIntake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    supplementId: "sup-1",
    companyId: "company-1",
    userId: "user-1",
    intakeDate: "2026-09-04",
    scheduledAt: new Date("2026-09-04T08:00:00.000Z"),
    takenAt: null,
    skippedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /supplements
// ---------------------------------------------------------------------------

describe("GET /supplements", () => {
  it("returns supplement list for the user (200)", async () => {
    const sup = makeSupplement();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([sup]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/supplements?companyId=company-1");

    expect(res.status).toBe(200);
    expect(res.body.supplements).toHaveLength(1);
    expect(res.body.supplements[0].name).toBe("Vitamin D");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/supplements");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /supplements
// ---------------------------------------------------------------------------

describe("POST /supplements", () => {
  it("creates a supplement and returns 201", async () => {
    const sup = makeSupplement();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([sup]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/supplements")
      .send({ companyId: "company-1", name: "Vitamin D", dose: "2000", unit: "IU" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Vitamin D");
  });

  it("returns 400 when name is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/supplements")
      .send({ companyId: "company-1", dose: "2000" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when dose is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/supplements")
      .send({ companyId: "company-1", name: "Vitamin D" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/supplements")
      .send({ name: "Vitamin D", dose: "2000" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /supplements/:id
// ---------------------------------------------------------------------------

describe("PATCH /supplements/:id", () => {
  it("updates supplement fields and returns updated record (200)", async () => {
    const sup = makeSupplement();
    const updated = { ...sup, dose: "4000", updatedAt: NOW };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([sup]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/supplements/sup-1")
      .send({ dose: "4000" });

    expect(res.status).toBe(200);
    expect(res.body.dose).toBe("4000");
  });

  it("returns 404 when supplement does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/supplements/not-found")
      .send({ dose: "4000" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /supplements/:id
// ---------------------------------------------------------------------------

describe("DELETE /supplements/:id", () => {
  it("deletes supplement and returns 204", async () => {
    const sup = makeSupplement();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([sup]),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/supplements/sup-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when supplement does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/supplements/not-found");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /supplements/intake/:date
// ---------------------------------------------------------------------------

describe("GET /supplements/intake/:date", () => {
  it("returns intake list for a date (200)", async () => {
    const sup = makeSupplement();
    const intake = makeIntake({ takenAt: new Date("2026-09-04T08:15:00.000Z") });

    let selectCall = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return { orderBy: vi.fn().mockResolvedValue([sup]) };
        return Promise.resolve([intake]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/supplements/intake/2026-09-04?companyId=company-1");

    expect(res.status).toBe(200);
    expect(res.body.date).toBe("2026-09-04");
    expect(res.body.intakes).toHaveLength(1);
    expect(res.body.intakes[0].name).toBe("Vitamin D");
    expect(res.body.intakes[0].takenAt).toBeTruthy();
  });

  it("returns empty intakes when no supplements exist (200)", async () => {
    let selectCall = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return { orderBy: vi.fn().mockResolvedValue([]) };
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/supplements/intake/2026-09-04?companyId=company-1");

    expect(res.status).toBe(200);
    expect(res.body.intakes).toHaveLength(0);
  });

  it("returns 400 for invalid date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .get("/supplements/intake/not-a-date?companyId=company-1");
    expect(res.status).toBe(400);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .get("/supplements/intake/2026-09-04");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /supplements/intake/:date/:supplementId/take
// ---------------------------------------------------------------------------

describe("POST /supplements/intake/:date/:supplementId/take", () => {
  it("creates intake record marked as taken (200)", async () => {
    const sup = makeSupplement();
    const intake = makeIntake({ takenAt: new Date("2026-09-04T08:10:00.000Z") });

    let selectCall = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return Promise.resolve([sup]); // supplement lookup
        return Promise.resolve([]); // no existing intake
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([intake]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/supplements/intake/2026-09-04/sup-1/take");

    expect(res.status).toBe(200);
    expect(res.body.takenAt).toBeTruthy();
    expect(res.body.name).toBe("Vitamin D");
  });

  it("updates existing intake record to taken (200)", async () => {
    const sup = makeSupplement();
    const existing = makeIntake({ skippedAt: new Date("2026-09-04T08:00:00.000Z") });
    const updated = { ...existing, takenAt: new Date("2026-09-04T08:30:00.000Z"), skippedAt: null };

    let selectCall = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return Promise.resolve([sup]);
        return Promise.resolve([existing]); // existing intake
      }),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/supplements/intake/2026-09-04/sup-1/take");

    expect(res.status).toBe(200);
    expect(res.body.takenAt).toBeTruthy();
    expect(res.body.skippedAt).toBeNull();
  });

  it("returns 404 when supplement does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/supplements/intake/2026-09-04/not-found/take");
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/supplements/intake/bad-date/sup-1/take");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /supplements/intake/:date/:supplementId/skip
// ---------------------------------------------------------------------------

describe("POST /supplements/intake/:date/:supplementId/skip", () => {
  it("creates intake record marked as skipped (200)", async () => {
    const sup = makeSupplement();
    const intake = makeIntake({ skippedAt: new Date("2026-09-04T09:00:00.000Z") });

    let selectCall = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return Promise.resolve([sup]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([intake]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/supplements/intake/2026-09-04/sup-1/skip");

    expect(res.status).toBe(200);
    expect(res.body.skippedAt).toBeTruthy();
    expect(res.body.takenAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /supplements/intake/:date/:supplementId
// ---------------------------------------------------------------------------

describe("DELETE /supplements/intake/:date/:supplementId", () => {
  it("removes intake record and returns 204", async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/supplements/intake/2026-09-04/sup-1");

    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalled();
  });
});
