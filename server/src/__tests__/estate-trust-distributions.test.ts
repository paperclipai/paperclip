import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes } from "../routes/estate.js";
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
  app.use(estateRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeTrust(overrides: Record<string, unknown> = {}) {
  return {
    id: "trust-1",
    estateId: "estate-1",
    companyId: "company-1",
    trustName: "Smith Living Trust",
    trustType: "revocable",
    trusteeUserId: "user-1",
    successorTrusteeName: null,
    fundingStatus: "unfunded",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDistribution(overrides: Record<string, unknown> = {}) {
  return {
    id: "dist-1",
    trustId: "trust-1",
    companyId: "company-1",
    beneficiaryId: "ben-1",
    beneficiaryName: "Jane Smith",
    amountCents: 100000,
    distributionDate: "2026-03-15",
    distributionType: "discretionary",
    description: "Quarterly distribution",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /estate/trusts/:trustId/distributions
// ---------------------------------------------------------------------------

describe("GET /estate/trusts/:trustId/distributions", () => {
  it("returns distributions for a trust with totals", async () => {
    const trust = makeTrust();
    const dist1 = makeDistribution({ id: "dist-1", amountCents: 100000 });
    const dist2 = makeDistribution({ id: "dist-2", amountCents: 50000, distributionType: "income" });
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([dist1, dist2]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/trust-1/distributions");
    expect(res.status).toBe(200);
    expect(res.body.distributions).toHaveLength(2);
    expect(res.body.totalAmountCents).toBe(150000);
    expect(res.body.totalAmountDollars).toBe(1500);
  });

  it("returns empty list when no distributions exist", async () => {
    const trust = makeTrust();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/trust-1/distributions");
    expect(res.status).toBe(200);
    expect(res.body.distributions).toHaveLength(0);
    expect(res.body.totalAmountCents).toBe(0);
  });

  it("returns 404 when trust is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/no-such-trust/distributions");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /estate/trusts/:trustId/distributions
// ---------------------------------------------------------------------------

describe("POST /estate/trusts/:trustId/distributions", () => {
  it("creates a distribution by beneficiaryId and returns 201", async () => {
    const trust = makeTrust();
    const dist = makeDistribution();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([dist]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({
        beneficiaryId: "ben-1",
        amountCents: 100000,
        distributionDate: "2026-03-15",
        distributionType: "discretionary",
        description: "Quarterly distribution",
      });

    expect(res.status).toBe(201);
    expect(res.body.distribution.amountCents).toBe(100000);
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("creates a distribution by beneficiaryName when no beneficiaryId", async () => {
    const trust = makeTrust();
    const dist = makeDistribution({ beneficiaryId: null, beneficiaryName: "External Heir" });
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([dist]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({
        beneficiaryName: "External Heir",
        amountCents: 50000,
        distributionDate: "2026-03-15",
      });

    expect(res.status).toBe(201);
    expect(res.body.distribution.beneficiaryName).toBe("External Heir");
  });

  it("returns 400 when amountCents is missing", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({ beneficiaryName: "Jane", distributionDate: "2026-03-15" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountCents/);
  });

  it("returns 400 when amountCents is zero or negative", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({ beneficiaryName: "Jane", amountCents: -1000, distributionDate: "2026-03-15" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountCents/);
  });

  it("returns 400 when distributionDate is missing", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({ beneficiaryName: "Jane", amountCents: 50000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/distributionDate/);
  });

  it("returns 400 when neither beneficiaryId nor beneficiaryName is provided", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({ amountCents: 50000, distributionDate: "2026-03-15" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/beneficiary/);
  });

  it("returns 400 when distributionType is invalid", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/distributions")
      .send({ beneficiaryName: "Jane", amountCents: 50000, distributionDate: "2026-03-15", distributionType: "bogus" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/distributionType/);
  });

  it("returns 404 when trust is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/no-such-trust/distributions")
      .send({ beneficiaryName: "Jane", amountCents: 50000, distributionDate: "2026-03-15" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /estate/trust-distributions/:distributionId
// ---------------------------------------------------------------------------

describe("PATCH /estate/trust-distributions/:distributionId", () => {
  it("updates distribution amount and returns the updated record", async () => {
    const dist = makeDistribution();
    const updated = { ...dist, amountCents: 200000, updatedAt: new Date() };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([dist])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trust-distributions/dist-1")
      .send({ amountCents: 200000 });

    expect(res.status).toBe(200);
    expect(res.body.distribution.amountCents).toBe(200000);
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 400 when amountCents is zero", async () => {
    const dist = makeDistribution();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([dist])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trust-distributions/dist-1")
      .send({ amountCents: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountCents/);
  });

  it("returns 400 when distributionType is invalid", async () => {
    const dist = makeDistribution();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([dist])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trust-distributions/dist-1")
      .send({ distributionType: "unknown" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/distributionType/);
  });

  it("returns 404 when distribution is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trust-distributions/no-such")
      .send({ amountCents: 50000 });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /estate/trust-distributions/:distributionId
// ---------------------------------------------------------------------------

describe("DELETE /estate/trust-distributions/:distributionId", () => {
  it("deletes a distribution and returns 204", async () => {
    const dist = makeDistribution();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([dist])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/trust-distributions/dist-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 when distribution is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/trust-distributions/no-such");
    expect(res.status).toBe(404);
  });
});
