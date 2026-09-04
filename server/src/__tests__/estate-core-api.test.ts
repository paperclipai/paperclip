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

function makeEstate(overrides: Record<string, unknown> = {}) {
  return {
    id: "estate-1",
    companyId: "company-1",
    ownerUserId: "user-1",
    name: "Smith Family Estate",
    estateType: "individual",
    maritalStatus: "married",
    stateOfResidence: "CA",
    notes: null,
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
    allocationPercentage: "100.00",
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

function makeCollaborator(overrides: Record<string, unknown> = {}) {
  return {
    id: "collab-1",
    estateId: "estate-1",
    companyId: "company-1",
    advisorUserId: null,
    invitedByUserId: "user-1",
    email: "advisor@example.com",
    accessLevel: "read",
    inviteToken: "abc123",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 30 * 86400000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// Helper to build a chainable DB mock with a terminal .then()
function selectOnce(result: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn(result)),
    }),
  };
}

// ---------------------------------------------------------------------------
// Estates CRUD
// ---------------------------------------------------------------------------

describe("GET /estates", () => {
  it("returns list of estates with nextCursor", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([estate]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.estates).toHaveLength(1);
    expect(res.body.estates[0].id).toBe("estate-1");
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await request(createApp({} as unknown as Db)).get("/estates");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });
});

describe("POST /estates", () => {
  it("creates an estate and returns 201", async () => {
    const estate = makeEstate();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([estate]),
    };
    const db = {
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates")
      .send({ companyId: "company-1", name: "Smith Family Estate" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Smith Family Estate");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/estates")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/estates")
      .send({ name: "My Estate" });
    expect(res.status).toBe(400);
  });
});

describe("GET /estates/:estateId", () => {
  it("returns a single estate", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("estate-1");
  });

  it("returns 404 for unknown estate", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/missing");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /estates/:estateId", () => {
  it("updates an estate and returns the updated row", async () => {
    const existing = makeEstate();
    const updated = { ...existing, name: "Updated Estate", updatedAt: new Date() };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estates/estate-1")
      .send({ name: "Updated Estate" });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 404 for missing estate", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/estates/missing").send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /estates/:estateId", () => {
  it("deletes an estate and returns 204", async () => {
    const existing = makeEstate();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estates/estate-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 for missing estate", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estates/missing");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Assets by Estate
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/assets", () => {
  it("returns assets for the estate", async () => {
    const estate = makeEstate();
    const asset = {
      id: "asset-1",
      estateId: "estate-1",
      companyId: "company-1",
      userId: "user-1",
      name: "House",
      assetType: "real_estate",
      currentValueCents: "50000000",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const assetListStub = {
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([asset]),
    };
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return assetListStub;
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/assets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
  });

  it("returns 404 for unknown estate", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/missing/assets");
    expect(res.status).toBe(404);
  });
});

describe("POST /estates/:estateId/assets", () => {
  it("creates an asset linked to the estate", async () => {
    const estate = makeEstate();
    const asset = {
      id: "asset-1",
      estateId: "estate-1",
      companyId: "company-1",
      userId: "user-1",
      name: "House",
      assetType: "real_estate",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([asset]),
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
      .post("/estates/estate-1/assets")
      .send({ name: "House", assetType: "real_estate" });

    expect(res.status).toBe(201);
    expect(res.body.estateId).toBe("estate-1");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when assetType is missing", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/assets")
      .send({ name: "House" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assetType/);
  });
});

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/beneficiaries", () => {
  it("returns beneficiaries for an estate", async () => {
    const estate = makeEstate();
    const ben = makeBeneficiary();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([ben]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/beneficiaries");
    expect(res.status).toBe(200);
    expect(res.body.beneficiaries).toHaveLength(1);
    expect(res.body.beneficiaries[0].name).toBe("Jane Smith");
  });
});

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
      .send({ name: "Jane Smith", relationship: "spouse", designationType: "primary" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Jane Smith");
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
      .send({ designationType: "primary" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });
});

describe("GET /estate/beneficiaries/:beneficiaryId", () => {
  it("returns a beneficiary by id", async () => {
    const ben = makeBeneficiary();
    const db = selectOnce([ben]) as unknown as Db;

    const res = await request(createApp(db)).get("/estate/beneficiaries/ben-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ben-1");
    expect(res.body.name).toBe("Jane Smith");
    expect(res.body.companyId).toBe("company-1");
  });

  it("returns 404 for unknown beneficiary", async () => {
    const db = selectOnce([]) as unknown as Db;

    const res = await request(createApp(db)).get("/estate/beneficiaries/unknown");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /estate/beneficiaries/:beneficiaryId", () => {
  it("updates a beneficiary", async () => {
    const existing = makeBeneficiary();
    const updated = { ...existing, name: "Jane M. Smith" };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/beneficiaries/ben-1")
      .send({ name: "Jane M. Smith" });

    expect(res.status).toBe(200);
  });

  it("returns 404 for missing beneficiary", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/estate/beneficiaries/missing").send({});
    expect(res.status).toBe(404);
  });
});

describe("DELETE /estate/beneficiaries/:beneficiaryId", () => {
  it("deletes a beneficiary and returns 204", async () => {
    const existing = makeBeneficiary();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/beneficiaries/ben-1");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Trusts
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/trusts", () => {
  it("returns trusts for an estate", async () => {
    const estate = makeEstate();
    const trust = makeTrust();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([trust]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/trusts");
    expect(res.status).toBe(200);
    expect(res.body.trusts).toHaveLength(1);
    expect(res.body.trusts[0].trustName).toBe("Smith Living Trust");
  });
});

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
});

describe("PATCH /estate/trusts/:trustId", () => {
  it("updates a trust", async () => {
    const existing = makeTrust();
    const updated = { ...existing, fundingStatus: "fully_funded" };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/trusts/trust-1")
      .send({ fundingStatus: "fully_funded" });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /estate/trusts/:trustId", () => {
  it("deletes a trust and returns 204", async () => {
    const existing = makeTrust();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/trusts/trust-1");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Trust-asset linkage
// ---------------------------------------------------------------------------

describe("POST /estate/trusts/:trustId/assets", () => {
  it("links an asset to a trust", async () => {
    const trust = makeTrust();
    const asset = { id: "asset-1", companyId: "company-1" };
    const linkRow = { trustId: "trust-1", assetId: "asset-1", createdAt: NOW };
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([linkRow]),
    };
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        const result = selectCount === 1 ? [trust] : [asset];
        return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn(result)) };
      }),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/assets")
      .send({ assetId: "asset-1" });

    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when assetId is missing", async () => {
    const trust = makeTrust();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/trusts/trust-1/assets")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assetId/);
  });
});

describe("DELETE /estate/trusts/:trustId/assets/:assetId", () => {
  it("unlinks an asset from a trust", async () => {
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

    const res = await request(createApp(db)).delete("/estate/trusts/trust-1/assets/asset-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });
});

describe("GET /estate/trusts/:trustId", () => {
  it("returns the trust by id", async () => {
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
    expect(res.body.trustName).toBe("Smith Living Trust");
    expect(res.body.trustType).toBe("revocable");
  });

  it("returns 404 for an unknown trust", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/no-such-trust");
    expect(res.status).toBe(404);
  });
});

describe("GET /estate/trusts/:trustId/assets", () => {
  it("returns assets linked to the trust with joined fields", async () => {
    const trust = makeTrust();
    const assetRow = {
      trustId: "trust-1",
      assetId: "asset-1",
      transferDate: "2025-06-01",
      transferDeedDocId: null,
      createdAt: NOW,
      assetName: "Family Home",
      assetType: "real_estate",
      currentValueCents: 50000000,
    };
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])) };
        }
        return Promise.resolve([assetRow]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/trust-1/assets");
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].assetName).toBe("Family Home");
    expect(res.body.assets[0].currentValueCents).toBe(50000000);
  });

  it("returns empty assets list when trust has no linked assets", async () => {
    const trust = makeTrust();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([trust])) };
        }
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/trust-1/assets");
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
  });

  it("returns 404 when trust is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/trusts/no-such-trust/assets");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/collaborators", () => {
  it("returns collaborators for an estate", async () => {
    const estate = makeEstate();
    const collab = makeCollaborator();
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])) };
        }
        return { orderBy: vi.fn().mockResolvedValue([collab]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/estate-1/collaborators");
    expect(res.status).toBe(200);
    expect(res.body.collaborators).toHaveLength(1);
    expect(res.body.collaborators[0].email).toBe("advisor@example.com");
  });
});

describe("POST /estates/:estateId/collaborators", () => {
  it("invites a collaborator and returns 201 with a token", async () => {
    const estate = makeEstate();
    const collab = makeCollaborator();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([collab]),
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
      .post("/estates/estate-1/collaborators")
      .send({ email: "advisor@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("advisor@example.com");
    expect(typeof res.body.inviteToken).toBe("string");
  });

  it("returns 400 when email is missing", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([estate])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estates/estate-1/collaborators")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/);
  });
});

describe("POST /estate/collaborators/:collaboratorId/accept", () => {
  it("accepts an invite and records advisorUserId", async () => {
    const collab = makeCollaborator();
    const accepted = { ...collab, acceptedAt: new Date(), advisorUserId: "user-1" };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([accepted]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([collab])),
      }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db)).post("/estate/collaborators/collab-1/accept");
    expect(res.status).toBe(200);
    expect(res.body.acceptedAt).toBeDefined();
  });

  it("returns 200 with message when already accepted", async () => {
    const collab = makeCollaborator({ acceptedAt: new Date() });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([collab])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).post("/estate/collaborators/collab-1/accept");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Already accepted");
  });

  it("returns 400 when invite is expired", async () => {
    const collab = makeCollaborator({ expiresAt: new Date("2020-01-01") });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([collab])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).post("/estate/collaborators/collab-1/accept");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/);
  });
});

describe("DELETE /estate/collaborators/:collaboratorId", () => {
  it("revokes a collaborator and returns 204", async () => {
    const collab = makeCollaborator();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([collab])),
      }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/collaborators/collab-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown collaborator", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/collaborators/missing");
    expect(res.status).toBe(404);
  });
});
