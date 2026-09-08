import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { symptomsRoutes } from "../routes/symptoms.js";
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
  app.use(symptomsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeSymptomLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "symptom-1",
    companyId: "company-1",
    userId: "user-1",
    symptomDate: "2026-09-08",
    symptom: "headache",
    severity: 3,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /symptoms
// ---------------------------------------------------------------------------

describe("GET /symptoms", () => {
  it("returns symptom logs for the user (200)", async () => {
    const log = makeSymptomLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/symptoms?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].symptom).toBe("headache");
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
      "/symptoms?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/symptoms?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/symptoms?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/symptoms?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/symptoms?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/symptoms?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/symptoms?companyId=company-1&from=not-a-date&to=2026-09-08",
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
    app.use(symptomsRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/symptoms?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /symptoms
// ---------------------------------------------------------------------------

describe("POST /symptoms", () => {
  it("creates a symptom log and returns 201", async () => {
    const log = makeSymptomLog();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "headache", severity: 3 });

    expect(res.status).toBe(201);
    expect(res.body.symptom).toBe("headache");
    expect(res.body.severity).toBe(3);
  });

  it("creates a symptom log without severity", async () => {
    const log = makeSymptomLog({ severity: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "fatigue" });

    expect(res.status).toBe(201);
  });

  it("allows multiple symptoms on the same date", async () => {
    const log1 = makeSymptomLog({ symptom: "headache" });
    const log2 = makeSymptomLog({ id: "symptom-2", symptom: "fatigue" });
    const db = {
      insert: vi.fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([log1]) }),
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([log2]) }),
        }),
    } as unknown as Db;

    const res1 = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "headache" });
    const res2 = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "fatigue" });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.symptom).toBe("headache");
    expect(res2.body.symptom).toBe("fatigue");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ symptomDate: "2026-09-08", symptom: "headache" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when symptomDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "bad-date", symptom: "headache" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when symptom is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when symptom is not a valid value", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "not_a_real_symptom" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when severity is out of range (0)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "headache", severity: 0 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when severity exceeds 5", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/symptoms")
      .send({ companyId: "company-1", symptomDate: "2026-09-08", symptom: "headache", severity: 6 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /symptoms/:id
// ---------------------------------------------------------------------------

describe("DELETE /symptoms/:id", () => {
  it("deletes the symptom log and returns 204", async () => {
    const log = makeSymptomLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/symptoms/symptom-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when symptom log does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/symptoms/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when symptom log belongs to a different user", async () => {
    const log = makeSymptomLog({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/symptoms/symptom-1");
    expect(res.status).toBe(404);
  });
});
