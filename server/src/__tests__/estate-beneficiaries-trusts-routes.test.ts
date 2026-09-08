import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes } from "../routes/estate.js";
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
  app.use(estateRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeEstate(overrides: Record<string, unknown> = {}) {
  return {
    id: "estate-1",
    companyId: "company-1",
    name: "Smith Estate",
    ownerUserId: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeBeneficiary(overrides: Record<string, unknown> = {}) {
  return {
    id: "ben-1",
    estateId: "estate-1",
    companyId: "company-1",
    name: "Jane Smith",
    relationship: "spouse",
    email: "jane@example.com",
    phone: null,
    allocationPercentage: "50.00",
    designationType: "primary",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// GET /estates/:estateId/beneficiaries
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/beneficiaries", () => {
  it("returns beneficiaries list for an estate", async () => {
    const estate = makeEstate();
    const ben1 = makeBeneficiary({ id: "ben-1" });
    const ben2 = makeBeneficiary({ id: "ben-2", name: "Bob Smith", designationType: "contingent" });
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([ben1, ben2]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/beneficiaries");
    expect(res.status).toBe(200);
    expect(res.body.beneficiaries).toHaveLength(2);
    expect(res.body.beneficiaries[0].name).toBe("Jane Smith");
  });

  it("returns empty list when no beneficiaries exist", async () => {
    const estate = makeEstate();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/beneficiaries");
    expect(res.status).toBe(200);
    expect(res.body.beneficiaries).toHaveLength(0);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/no-such-estate/beneficiaries");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /estates/:estateId/beneficiaries
// ---------------------------------------------------------------------------

describe("POST /estates/:estateId/beneficiaries", () => {
  it("creates a beneficiary and returns 201", async () => {
    const estate = makeEstate();
    const ben = makeBeneficiary();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([ben]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/beneficiaries")
      .send({ name: "Jane Smith", relationship: "spouse", designationType: "primary", allocationPercentage: "50" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Jane Smith");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("defaults designationType to primary when omitted", async () => {
    const estate = makeEstate();
    const ben = makeBeneficiary({ designationType: "primary" });
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([ben]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/beneficiaries")
      .send({ name: "Bob" });

    expect(res.status).toBe(201);
  });

  it("returns 400 when name is missing", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/beneficiaries")
      .send({ relationship: "child" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/no-such/beneficiaries")
      .send({ name: "Jane" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /estate/beneficiaries/:beneficiaryId
// ---------------------------------------------------------------------------

describe("GET /estate/beneficiaries/:beneficiaryId", () => {
  it("returns the beneficiary record", async () => {
    const ben = makeBeneficiary();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([ben])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/beneficiaries/ben-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ben-1");
    expect(res.body.name).toBe("Jane Smith");
  });

  it("returns 404 when not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/beneficiaries/no-such");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /estate/beneficiaries/:beneficiaryId
// ---------------------------------------------------------------------------

describe("PATCH /estate/beneficiaries/:beneficiaryId", () => {
  it("updates a beneficiary and returns the updated record", async () => {
    const ben = makeBeneficiary();
    const updated = { ...ben, name: "Jane Doe", updatedAt: new Date() };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([ben])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/beneficiaries/ben-1")
      .send({ name: "Jane Doe" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Jane Doe");
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 404 when beneficiary is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/beneficiaries/no-such")
      .send({ name: "Jane" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /estate/beneficiaries/:beneficiaryId
// ---------------------------------------------------------------------------

describe("DELETE /estate/beneficiaries/:beneficiaryId", () => {
  it("deletes a beneficiary and returns 204", async () => {
    const ben = makeBeneficiary();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([ben])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/beneficiaries/ben-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 when beneficiary is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/beneficiaries/no-such");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /estates/:estateId/trusts
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/trusts", () => {
  it("returns trusts list for an estate", async () => {
    const estate = makeEstate();
    const trust1 = makeTrust({ id: "trust-1" });
    const trust2 = makeTrust({ id: "trust-2", trustName: "Smith Irrevocable Trust", trustType: "irrevocable" });
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([trust1, trust2]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/trusts");
    expect(res.status).toBe(200);
    expect(res.body.trusts).toHaveLength(2);
    expect(res.body.trusts[0].trustName).toBe("Smith Living Trust");
  });

  it("returns empty list when no trusts exist", async () => {
    const estate = makeEstate();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/trusts");
    expect(res.status).toBe(200);
    expect(res.body.trusts).toHaveLength(0);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/no-such-estate/trusts");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /estates/:estateId/trusts
// ---------------------------------------------------------------------------

describe("POST /estates/:estateId/trusts", () => {
  it("creates a trust and returns 201", async () => {
    const estate = makeEstate();
    const trust = makeTrust();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([trust]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/trusts")
      .send({ trustName: "Smith Living Trust", trustType: "revocable" });

    expect(res.status).toBe(201);
    expect(res.body.trustName).toBe("Smith Living Trust");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("defaults fundingStatus to unfunded when omitted", async () => {
    const estate = makeEstate();
    const trust = makeTrust({ fundingStatus: "unfunded" });
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([trust]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/trusts")
      .send({ trustName: "Family Trust", trustType: "revocable" });

    expect(res.status).toBe(201);
    expect(res.body.fundingStatus).toBe("unfunded");
  });

  it("returns 400 when trustName is missing", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/trusts")
      .send({ trustType: "revocable" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trustName/);
  });

  it("returns 400 when trustType is missing", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/trusts")
      .send({ trustName: "My Trust" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trustType/);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/no-such/trusts")
      .send({ trustName: "My Trust", trustType: "revocable" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /estate/trusts/:trustId
// ---------------------------------------------------------------------------

describe("GET /estate/trusts/:trustId", () => {
  it("returns the trust record", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/trust-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("trust-1");
    expect(res.body.trustType).toBe("revocable");
  });

  it("returns 404 when not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/no-such");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /estate/trusts/:trustId
// ---------------------------------------------------------------------------

describe("PATCH /estate/trusts/:trustId", () => {
  it("updates a trust funding status and returns the updated record", async () => {
    const trust = makeTrust();
    const updated = { ...trust, fundingStatus: "fully_funded", updatedAt: new Date() };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trusts/trust-1")
      .send({ fundingStatus: "fully_funded" });

    expect(res.status).toBe(200);
    expect(res.body.fundingStatus).toBe("fully_funded");
    expect(db.update).toHaveBeenCalledOnce();
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
      .patch("/estate/trusts/no-such")
      .send({ fundingStatus: "fully_funded" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /estate/trusts/:trustId
// ---------------------------------------------------------------------------

describe("DELETE /estate/trusts/:trustId", () => {
  it("deletes a trust and returns 204", async () => {
    const trust = makeTrust();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/trusts/trust-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 when trust is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/trusts/no-such");
    expect(res.status).toBe(404);
  });
});
