import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes } from "../routes/estate.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Shared helpers
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

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Test Asset",
    assetType: "investment",
    category: null,
    tags: null,
    entityId: null,
    currentValueCents: "10000000",
    valuationDate: NOW,
    typeMetadata: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Builds a db mock that:
 * 1. resolveAsset: first select/from/where returns [asset]
 * 2. detail fetch: second select/from/where returns detailRows
 */
function buildReadDb(asset: ReturnType<typeof makeAsset>, detailRows: unknown[]) {
  let callCount = 0;
  const whereMock = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([asset]);
    return Promise.resolve(detailRows);
  });

  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: whereMock,
  } as unknown as Db;
}

/**
 * Builds a db mock for upsert routes (PUT).
 * First select (resolveAsset) returns [asset].
 * Second select (existing check) returns existingRows.
 * update/insert chain returns updatedOrCreated.
 */
function buildUpsertDb(
  asset: ReturnType<typeof makeAsset>,
  existingRows: unknown[],
  saved: unknown,
  mode: "update" | "insert" = "update",
) {
  let selectCallCount = 0;
  const whereMock = vi.fn().mockImplementation(() => {
    selectCallCount++;
    if (selectCallCount === 1) return Promise.resolve([asset]);
    return Promise.resolve(existingRows);
  });

  const returningMock = vi.fn().mockResolvedValue([saved]);
  const setMock = vi.fn().mockReturnThis();
  const updateWhereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });

  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: whereMock,
    update: vi.fn().mockReturnValue({ set: setMock }),
    insert: vi.fn().mockReturnValue({ values: valuesMock }),
    // make update().set().where() work
    _setMock: setMock,
    _updateWhereMock: updateWhereMock,
    _returningMock: returningMock,
  } as unknown as Db & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Insurance Policy Routes
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/insurance", () => {
  it("returns 404 when detail not set up yet", async () => {
    const asset = makeAsset();
    const db = buildReadDb(asset, []);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/insurance?companyId=company-1");
    expect(res.status).toBe(404);
  });

  it("returns the insurance policy detail", async () => {
    const asset = makeAsset();
    const detail = {
      id: "ins-1",
      assetId: "asset-1",
      policyType: "term",
      deathBenefitCents: "200000000",
      premiumAmountCents: "50000",
      premiumFrequency: "monthly",
    };
    const db = buildReadDb(asset, [detail]);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/insurance?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ins-1");
    expect(res.body.policyType).toBe("term");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/assets/asset-1/insurance");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });

  it("returns 404 when the parent asset does not exist", async () => {
    let callCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve([]);
      }),
    } as unknown as Db;
    const res = await request(createApp(db))
      .get("/estate/assets/missing/insurance?companyId=company-1");
    expect(res.status).toBe(404);
  });
});

describe("PUT /estate/assets/:assetId/insurance", () => {
  it("creates insurance detail when none exists (201)", async () => {
    const asset = makeAsset();
    const created = { id: "ins-new", assetId: "asset-1", policyType: "whole_life" };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([created]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/insurance")
      .send({ companyId: "company-1", policyType: "whole_life", deathBenefitCents: 200000000 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("ins-new");
  });

  it("updates existing insurance detail (200)", async () => {
    const asset = makeAsset();
    const existing = { id: "ins-1" };
    const updated = { id: "ins-1", assetId: "asset-1", policyType: "universal_life", outstandingLoanCents: "500000" };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([updated]);
    const whereMock2 = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([existing]);
      }),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/insurance")
      .send({ companyId: "company-1", policyType: "universal_life", outstandingLoanCents: 500000 });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ins-1");
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/insurance")
      .send({ policyType: "term" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });
});

describe("DELETE /estate/assets/:assetId/insurance", () => {
  it("deletes and returns 204", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/assets/asset-1/insurance?companyId=company-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Retirement Account Routes
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/retirement", () => {
  it("returns retirement account detail", async () => {
    const asset = makeAsset();
    const detail = {
      id: "ret-1",
      assetId: "asset-1",
      accountType: "roth_401k",
      isRoth: true,
      rmdRequired: false,
    };
    const db = buildReadDb(asset, [detail]);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/retirement?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.accountType).toBe("roth_401k");
  });

  it("returns 404 when no detail exists", async () => {
    const asset = makeAsset();
    const db = buildReadDb(asset, []);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/retirement?companyId=company-1");
    expect(res.status).toBe(404);
  });
});

describe("PUT /estate/assets/:assetId/retirement", () => {
  it("creates retirement detail (201)", async () => {
    const asset = makeAsset();
    const created = {
      id: "ret-new",
      assetId: "asset-1",
      accountType: "traditional_ira",
      isRoth: false,
      rmdRequired: true,
      rmdDueYear: 2027,
    };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([created]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/retirement")
      .send({
        companyId: "company-1",
        accountType: "traditional_ira",
        rmdRequired: true,
        rmdDueYear: 2027,
        primaryBeneficiaries: [{ name: "Spouse", relationship: "spouse", percentage: 100 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.rmdRequired).toBe(true);
    expect(res.body.rmdDueYear).toBe(2027);
  });

  it("updates existing retirement detail (200)", async () => {
    const asset = makeAsset();
    const existing = { id: "ret-1" };
    const updated = { id: "ret-1", accountType: "roth_ira", isRoth: true };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([updated]);
    const whereMock2 = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([existing]);
      }),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/retirement")
      .send({ companyId: "company-1", accountType: "roth_ira", isRoth: true });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ret-1");
    expect(db.update).toHaveBeenCalledOnce();
  });
});

describe("DELETE /estate/assets/:assetId/retirement", () => {
  it("deletes and returns 204", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/assets/asset-1/retirement?companyId=company-1");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Business Interest Routes
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/business", () => {
  it("returns business interest detail", async () => {
    const asset = makeAsset();
    const detail = {
      id: "biz-1",
      assetId: "asset-1",
      businessName: "Acme LLC",
      entityType: "llc",
      ownershipPct: "51.0000",
      hasBuySellAgreement: true,
    };
    const db = buildReadDb(asset, [detail]);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/business?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("Acme LLC");
    expect(res.body.hasBuySellAgreement).toBe(true);
  });

  it("returns 404 when no detail exists", async () => {
    const asset = makeAsset();
    const db = buildReadDb(asset, []);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/business?companyId=company-1");
    expect(res.status).toBe(404);
  });
});

describe("PUT /estate/assets/:assetId/business", () => {
  it("creates business detail (201)", async () => {
    const asset = makeAsset();
    const created = {
      id: "biz-new",
      assetId: "asset-1",
      businessName: "Acme LLC",
      entityType: "llc",
    };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([created]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/business")
      .send({
        companyId: "company-1",
        businessName: "Acme LLC",
        entityType: "llc",
        ownershipPct: 51,
        hasBuySellAgreement: true,
        nextAppraisalDueDate: "2027-01-01T00:00:00Z",
      });

    expect(res.status).toBe(201);
    expect(res.body.businessName).toBe("Acme LLC");
  });

  it("returns 400 when businessName is missing", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/business")
      .send({ companyId: "company-1", entityType: "llc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/businessName/);
  });

  it("updates existing business detail (200)", async () => {
    const asset = makeAsset();
    const existing = { id: "biz-1" };
    const updated = { id: "biz-1", businessName: "Acme Corp", entityType: "s_corp" };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([updated]);
    const whereMock2 = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([existing]);
      }),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/business")
      .send({ companyId: "company-1", businessName: "Acme Corp", entityType: "s_corp" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("biz-1");
  });
});

describe("DELETE /estate/assets/:assetId/business", () => {
  it("deletes and returns 204", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/assets/asset-1/business?companyId=company-1");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Digital Asset Routes
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/digital", () => {
  it("returns digital asset detail", async () => {
    const asset = makeAsset();
    const detail = {
      id: "dig-1",
      assetId: "asset-1",
      digitalAssetType: "cryptocurrency",
      ticker: "BTC",
      blockchain: "bitcoin",
      quantityHeld: "0.5",
    };
    const db = buildReadDb(asset, [detail]);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/digital?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.ticker).toBe("BTC");
  });

  it("returns 404 when no detail exists", async () => {
    const asset = makeAsset();
    const db = buildReadDb(asset, []);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/digital?companyId=company-1");
    expect(res.status).toBe(404);
  });
});

describe("PUT /estate/assets/:assetId/digital", () => {
  it("creates digital asset detail (201)", async () => {
    const asset = makeAsset();
    const created = {
      id: "dig-new",
      assetId: "asset-1",
      digitalAssetType: "cryptocurrency",
      ticker: "ETH",
    };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([created]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/digital")
      .send({
        companyId: "company-1",
        digitalAssetType: "cryptocurrency",
        ticker: "ETH",
        blockchain: "ethereum",
        quantityHeld: 1.5,
        walletAddresses: [{ label: "Cold Storage", address: "0xABC", isHardware: true }],
        exchangeAccounts: [{ exchangeName: "Coinbase", accountId: "acc-123" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.ticker).toBe("ETH");
  });

  it("updates existing digital asset detail (200)", async () => {
    const asset = makeAsset();
    const existing = { id: "dig-1" };
    const updated = { id: "dig-1", ticker: "BTC", quantityHeld: "1.0" };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([updated]);
    const whereMock2 = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([existing]);
      }),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/digital")
      .send({ companyId: "company-1", ticker: "BTC", quantityHeld: 1.0 });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("dig-1");
    expect(db.update).toHaveBeenCalledOnce();
  });
});

describe("DELETE /estate/assets/:assetId/digital", () => {
  it("deletes and returns 204", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/assets/asset-1/digital?companyId=company-1");
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Collectible Routes
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/collectible", () => {
  it("returns collectible detail", async () => {
    const asset = makeAsset();
    const detail = {
      id: "col-1",
      assetId: "asset-1",
      collectibleType: "art",
      artist: "Monet",
      yearCreated: "1892",
      insuredValueCents: "5000000000",
    };
    const db = buildReadDb(asset, [detail]);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/collectible?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.artist).toBe("Monet");
    expect(res.body.collectibleType).toBe("art");
  });

  it("returns 404 when no detail exists", async () => {
    const asset = makeAsset();
    const db = buildReadDb(asset, []);
    const res = await request(createApp(db))
      .get("/estate/assets/asset-1/collectible?companyId=company-1");
    expect(res.status).toBe(404);
  });
});

describe("PUT /estate/assets/:assetId/collectible", () => {
  it("creates collectible detail (201)", async () => {
    const asset = makeAsset();
    const created = {
      id: "col-new",
      assetId: "asset-1",
      collectibleType: "jewelry",
      maker: "Tiffany",
    };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([created]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/collectible")
      .send({
        companyId: "company-1",
        collectibleType: "jewelry",
        maker: "Tiffany",
        condition: "excellent",
        insuredValueCents: 25000000,
        provenanceDocIds: ["doc-1"],
        authCertDocIds: ["doc-2"],
        insuranceRiderDocIds: ["doc-3"],
        storageFacility: "Safe Deposit Box — First National Bank",
      });

    expect(res.status).toBe(201);
    expect(res.body.maker).toBe("Tiffany");
  });

  it("updates existing collectible detail (200)", async () => {
    const asset = makeAsset();
    const existing = { id: "col-1" };
    const updated = { id: "col-1", collectibleType: "art", artist: "Picasso" };

    let selectCount = 0;
    const returningMock = vi.fn().mockResolvedValue([updated]);
    const whereMock2 = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([existing]);
      }),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .put("/estate/assets/asset-1/collectible")
      .send({ companyId: "company-1", collectibleType: "art", artist: "Picasso" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("col-1");
    expect(db.update).toHaveBeenCalledOnce();
  });
});

describe("DELETE /estate/assets/:assetId/collectible", () => {
  it("deletes and returns 204", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/assets/asset-1/collectible?companyId=company-1");
    expect(res.status).toBe(204);
  });
});
