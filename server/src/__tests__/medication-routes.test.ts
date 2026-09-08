import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { medicationsRoutes } from "../routes/medications.js";
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
  app.use(medicationsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeMedicationLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "med-1",
    companyId: "company-1",
    userId: "user-1",
    medicationDate: "2026-09-08",
    medicationName: "Ibuprofen",
    dosage: "200mg",
    taken: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /medications
// ---------------------------------------------------------------------------

describe("GET /medications", () => {
  it("returns medication logs for the user (200)", async () => {
    const log = makeMedicationLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/medications?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].medicationName).toBe("Ibuprofen");
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
      "/medications?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/medications?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/medications?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/medications?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/medications?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/medications?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/medications?companyId=company-1&from=not-a-date&to=2026-09-08",
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
    app.use(medicationsRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/medications?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /medications
// ---------------------------------------------------------------------------

describe("POST /medications", () => {
  it("creates a medication log and returns 201", async () => {
    const log = makeMedicationLog();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/medications")
      .send({
        companyId: "company-1",
        medicationDate: "2026-09-08",
        medicationName: "Ibuprofen",
        dosage: "200mg",
      });

    expect(res.status).toBe(201);
    expect(res.body.medicationName).toBe("Ibuprofen");
    expect(res.body.dosage).toBe("200mg");
    expect(res.body.taken).toBe(true);
  });

  it("creates a medication log without dosage", async () => {
    const log = makeMedicationLog({ dosage: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/medications")
      .send({
        companyId: "company-1",
        medicationDate: "2026-09-08",
        medicationName: "Aspirin",
      });

    expect(res.status).toBe(201);
  });

  it("creates a medication log with taken=false", async () => {
    const log = makeMedicationLog({ taken: false });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/medications")
      .send({
        companyId: "company-1",
        medicationDate: "2026-09-08",
        medicationName: "Metformin",
        taken: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.taken).toBe(false);
  });

  it("allows multiple medications on the same date", async () => {
    const log1 = makeMedicationLog({ medicationName: "Ibuprofen" });
    const log2 = makeMedicationLog({ id: "med-2", medicationName: "Aspirin" });
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
      .post("/medications")
      .send({ companyId: "company-1", medicationDate: "2026-09-08", medicationName: "Ibuprofen" });
    const res2 = await request(createApp(db))
      .post("/medications")
      .send({ companyId: "company-1", medicationDate: "2026-09-08", medicationName: "Aspirin" });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.medicationName).toBe("Ibuprofen");
    expect(res2.body.medicationName).toBe("Aspirin");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/medications")
      .send({ medicationDate: "2026-09-08", medicationName: "Ibuprofen" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when medicationDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/medications")
      .send({ companyId: "company-1", medicationDate: "bad-date", medicationName: "Ibuprofen" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when medicationName is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/medications")
      .send({ companyId: "company-1", medicationDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when medicationName is empty string", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/medications")
      .send({ companyId: "company-1", medicationDate: "2026-09-08", medicationName: "  " });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /medications/:id
// ---------------------------------------------------------------------------

describe("DELETE /medications/:id", () => {
  it("deletes the medication log and returns 204", async () => {
    const log = makeMedicationLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/medications/med-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when medication log does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/medications/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when medication log belongs to a different user", async () => {
    const log = makeMedicationLog({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/medications/med-1");
    expect(res.status).toBe(404);
  });
});
