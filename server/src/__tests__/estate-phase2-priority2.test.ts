import { describe, it, expect, vi } from "vitest";
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

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    name: "AAPL Investment",
    assetType: "investment",
    category: null,
    tags: null,
    entityId: null,
    currentValueCents: "5000000",
    valuationDate: NOW,
    typeMetadata: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Checking",
    institutionName: "Big Bank",
    accountType: "checking",
    entityId: null,
    balanceCents: "200000",
    balanceUpdatedAt: NOW,
    isManual: true,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTaxLot(overrides: Record<string, unknown> = {}) {
  return {
    id: "lot-1",
    assetId: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    ticker: "AAPL",
    cusip: null,
    securityName: "Apple Inc",
    shares: "10",
    costBasisPerShareCents: "15000",
    totalCostBasisCents: "150000",
    acquiredAt: new Date("2020-01-01T00:00:00Z"),
    currentPricePerShareCents: "18000",
    currentValueCents: "180000",
    status: "open",
    soldAt: null,
    salePerShareCents: null,
    isLongTerm: true,
    isWashSale: false,
    washSaleDisallowedCents: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Portfolio Consolidation View
// ---------------------------------------------------------------------------

describe("GET /estate/portfolio", () => {
  it("returns consolidated portfolio with allocation breakdown", async () => {
    const asset = makeAsset();
    const account = makeAccount();
    let queryCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([account]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/portfolio?companyId=company-1&userId=user-1");
    expect(res.status).toBe(200);
    expect(res.body.netWorthCents).toBe(5200000);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.allocationByClass).toBeDefined();
    expect(res.body.allocationByClass.investment).toBeDefined();
    expect(res.body.allocationByClass.investment.count).toBe(1);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/portfolio");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });

  it("computes allocation percentages correctly", async () => {
    // 2 assets: 8000000 cents investment + 2000000 cents real_estate = 10M total
    const assets = [
      makeAsset({ id: "a1", assetType: "investment", currentValueCents: "8000000" }),
      makeAsset({ id: "a2", assetType: "real_estate", currentValueCents: "2000000" }),
    ];
    let queryCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return Promise.resolve(assets);
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/portfolio?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.allocationByClass.investment.allocationPct).toBe(80);
    expect(res.body.allocationByClass.real_estate.allocationPct).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Net Worth History Snapshots
// ---------------------------------------------------------------------------

describe("POST /estate/net-worth/snapshot", () => {
  it("creates a net worth snapshot (201)", async () => {
    const snapshot = {
      id: "snap-1",
      companyId: "company-1",
      userId: "user-1",
      snapshotDate: NOW,
      netWorthCents: "5200000",
      assetsTotalCents: "5000000",
      accountsTotalCents: "200000",
      breakdown: { investment: 5000000 },
      createdAt: NOW,
    };

    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockImplementation(() => {
        selectCount++;
        return Promise.resolve([{ assetType: "investment", total: "5000000" }]);
      }),
      // first two wheres resolve for asset + account totals
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([snapshot]) }),
      }),
    } as unknown as Db;

    // Need to handle multiple query chains — use a call-count approach
    let chainCount = 0;
    const whereMock = vi.fn().mockImplementation(() => {
      chainCount++;
      if (chainCount <= 2) {
        return {
          // For asset/account aggregation queries that have direct .from().where() → resolve
          then: (fn: (r: unknown[]) => unknown) =>
            Promise.resolve(fn([{ total: chainCount === 1 ? "5000000" : "200000" }])),
        };
      }
      return { groupBy: vi.fn().mockResolvedValue([{ assetType: "investment", total: "5000000" }]) };
    });

    const db2 = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereMock,
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([snapshot]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db2))
      .post("/estate/net-worth/snapshot")
      .send({ companyId: "company-1", userId: "user-1" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("snap-1");
    expect(db2.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/net-worth/snapshot")
      .send({ userId: "user-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });
});

describe("GET /estate/net-worth/history", () => {
  it("returns snapshot history", async () => {
    const snaps = [
      {
        id: "s1",
        snapshotDate: new Date("2026-01-01"),
        netWorthCents: "5000000",
        assetsTotalCents: "4800000",
        accountsTotalCents: "200000",
        breakdown: null,
      },
      {
        id: "s2",
        snapshotDate: new Date("2026-02-01"),
        netWorthCents: "5200000",
        assetsTotalCents: "5000000",
        accountsTotalCents: "200000",
        breakdown: null,
      },
    ];
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue(snaps),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/net-worth/history?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
    expect(res.body.snapshots[1].netWorthDollars).toBe(52000);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/net-worth/history");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tax Lot Tracking
// ---------------------------------------------------------------------------

describe("GET /estate/assets/:assetId/tax-lots", () => {
  it("returns lot list with summary", async () => {
    const asset = makeAsset();
    const lot = makeTaxLot();

    // resolveAsset awaits .where() directly; tax-lots query awaits .where().orderBy()
    let whereCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        whereCount++;
        if (whereCount === 1) {
          // resolveAsset awaits this directly
          return Promise.resolve([asset]);
        }
        // lots query: return object with .orderBy()
        return { orderBy: vi.fn().mockResolvedValue([lot]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/estate/assets/asset-1/tax-lots?companyId=company-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.lots).toHaveLength(1);
    expect(res.body.lots[0].ticker).toBe("AAPL");
    expect(res.body.summary.openLots).toBe(1);
    expect(res.body.summary.unrealizedGainCents).toBe(30000); // 180000 - 150000
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/assets/asset-1/tax-lots");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });

  it("returns 404 when asset does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      // resolveAsset awaits .where() — return empty array → 404
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/estate/assets/missing/tax-lots?companyId=company-1",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /estate/assets/:assetId/tax-lots", () => {
  it("creates a new tax lot (201)", async () => {
    const asset = makeAsset();
    const lot = makeTaxLot({ id: "lot-new" });

    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([asset]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([lot]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/assets/asset-1/tax-lots")
      .send({
        companyId: "company-1",
        ticker: "AAPL",
        shares: 10,
        costBasisPerShareCents: 15000,
        acquiredAt: "2020-01-01T00:00:00Z",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("lot-new");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when shares is missing", async () => {
    const asset = makeAsset();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        return Promise.resolve(selectCount === 1 ? [asset] : []);
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/assets/asset-1/tax-lots")
      .send({ companyId: "company-1", costBasisPerShareCents: 15000, acquiredAt: "2020-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shares/);
  });
});

describe("PATCH /estate/tax-lots/:lotId", () => {
  it("updates current price and computes current value", async () => {
    const lot = makeTaxLot();
    const updated = { ...lot, currentPricePerShareCents: "20000", currentValueCents: "200000" };

    const whereMock2 = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) });
    const setMock = vi.fn().mockReturnValue({ where: whereMock2 });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([lot]),
      update: vi.fn().mockReturnValue({ set: setMock }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/tax-lots/lot-1")
      .send({ companyId: "company-1", currentPricePerShareCents: 20000 });

    expect(res.status).toBe(200);
    expect(res.body.currentValueCents).toBe("200000");
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown lot", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/tax-lots/missing")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /estate/tax-lots/:lotId", () => {
  it("deletes and returns 204", async () => {
    const lot = makeTaxLot();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return Promise.resolve([lot]);
        return Promise.resolve([]);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete(
      "/estate/tax-lots/lot-1?companyId=company-1",
    );
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// RMD Summary Engine
// ---------------------------------------------------------------------------

describe("GET /estate/rmd-summary", () => {
  it("returns RMD summary with shortfall analysis", async () => {
    const retirementRow = {
      id: "ret-1",
      assetId: "asset-1",
      accountType: "traditional_ira",
      isRoth: false,
      rmdRequired: true,
      rmdAmountCents: "500000",
      rmdDueYear: 2026,
      rmdWithdrawnThisYearCents: "300000",
      custodian: "Fidelity",
      assetName: "Trad IRA",
      assetValueCents: "5000000",
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([retirementRow]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/estate/rmd-summary?companyId=company-1&year=2026",
    );
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2026);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].rmdRemainingCents).toBe(200000);
    expect(res.body.accounts[0].isFullySatisfied).toBe(false);
    expect(res.body.summary.totalRmdDueCents).toBe(500000);
    expect(res.body.summary.allSatisfied).toBe(false);
  });

  it("marks RMD as satisfied when withdrawn >= due", async () => {
    const retirementRow = {
      id: "ret-1",
      assetId: "asset-1",
      accountType: "traditional_ira",
      isRoth: false,
      rmdRequired: true,
      rmdAmountCents: "500000",
      rmdDueYear: 2026,
      rmdWithdrawnThisYearCents: "600000",
      custodian: "Vanguard",
      assetName: "IRA",
      assetValueCents: "4000000",
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([retirementRow]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/estate/rmd-summary?companyId=company-1&year=2026",
    );
    expect(res.status).toBe(200);
    expect(res.body.accounts[0].rmdRemainingCents).toBe(0);
    expect(res.body.accounts[0].isFullySatisfied).toBe(true);
    expect(res.body.summary.allSatisfied).toBe(true);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/rmd-summary");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Estate Value Projection
// ---------------------------------------------------------------------------

describe("GET /estate/projection", () => {
  it("projects net worth forward over 5 years", async () => {
    const assets = [makeAsset({ assetType: "investment", currentValueCents: "10000000" })];
    const accounts = [makeAccount({ balanceCents: "0" })];

    let queryCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockImplementation(() => {
        queryCount++;
        // First two calls for assets and accounts
        if (queryCount === 1) return Promise.resolve(assets);
        return Promise.resolve(accounts);
      }),
    } as unknown as Db;

    // Use Promise.all path — mock where to return directly
    const db2 = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return Promise.resolve(assets);
        return Promise.resolve(accounts);
      }),
    } as unknown as Db;
    queryCount = 0;

    const res = await request(createApp(db2)).get(
      "/estate/projection?companyId=company-1&years=5",
    );
    expect(res.status).toBe(200);
    expect(res.body.horizonYears).toBe(5);
    expect(res.body.projections).toHaveLength(5);
    // Investment at 7% annual: 10M * 1.07 = 10,700,000 after year 1
    expect(res.body.projections[0].projectedNetWorthCents).toBe(10700000);
    // Year 2: 10,700,000 * 1.07 = 11,449,000
    expect(res.body.projections[1].projectedNetWorthCents).toBe(11449000);
  });

  it("caps horizon at 50 years", async () => {
    const assets = [makeAsset({ currentValueCents: "1000000" })];
    let queryCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return Promise.resolve(assets);
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/estate/projection?companyId=company-1&years=100",
    );
    expect(res.status).toBe(200);
    expect(res.body.horizonYears).toBe(50);
    expect(res.body.projections).toHaveLength(50);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/projection");
    expect(res.status).toBe(400);
  });
});
