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

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Main Residence",
    assetType: "real_estate",
    category: null,
    tags: null,
    entityId: null,
    currentValueCents: "50000000",
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
    balanceCents: "500000",
    balanceUpdatedAt: NOW,
    isManual: true,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Asset registry
// ---------------------------------------------------------------------------

describe("GET /estate/assets", () => {
  it("returns asset list for the authenticated user", async () => {
    const asset = makeAsset();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([asset]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/assets?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].id).toBe("asset-1");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/assets");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });
});

describe("GET /estate/assets/:assetId", () => {
  it("returns a single asset", async () => {
    const asset = makeAsset();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([asset])),
    } as unknown as Db;
    // chain the query builder
    (db as any).where.mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([asset])) });

    const res = await request(createApp(db)).get("/estate/assets/asset-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("asset-1");
  });

  it("returns 404 for unknown asset", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])) }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/assets/missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /estate/assets", () => {
  it("creates an asset and returns 201", async () => {
    const asset = makeAsset();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([asset]),
    };
    const db = {
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/assets")
      .send({ companyId: "company-1", name: "Main Residence", assetType: "real_estate" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Main Residence");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns 400 when name is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/assets")
      .send({ companyId: "company-1", assetType: "real_estate" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it("returns 400 when assetType is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/assets")
      .send({ companyId: "company-1", name: "Something" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assetType/);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/assets")
      .send({ name: "Something", assetType: "other" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /estate/assets/:assetId", () => {
  it("updates an asset and returns the updated row", async () => {
    const existing = makeAsset();
    const updated = { ...existing, name: "Updated Name", updatedAt: new Date() };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])) }),
      update: vi.fn().mockReturnValue(updateMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/assets/asset-1")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("returns 404 for missing asset", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])) }),
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/estate/assets/missing").send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /estate/assets/:assetId", () => {
  it("deletes an asset and returns 204", async () => {
    const existing = makeAsset();
    const deleteMock = { where: vi.fn().mockResolvedValue(undefined) };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])) }),
      delete: vi.fn().mockReturnValue(deleteMock),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/assets/asset-1");
    expect(res.status).toBe(204);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 for missing asset", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])) }),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/assets/missing");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CSV bulk import
// ---------------------------------------------------------------------------

describe("POST /estate/assets/import-csv", () => {
  const validCsv = "name,asset_type,current_value_cents\nVacation Home,real_estate,30000000\nTesla,vehicle,8000000";

  it("imports valid CSV rows and returns count", async () => {
    const asset1 = makeAsset({ name: "Vacation Home" });
    const asset2 = makeAsset({ id: "asset-2", name: "Tesla", assetType: "vehicle" });
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([asset1, asset2]),
    };
    const db = {
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/assets/import-csv")
      .send({ companyId: "company-1", csv: validCsv });

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);
    expect(res.body.errors).toHaveLength(0);
  });

  it("returns errors for rows missing required fields", async () => {
    const badCsv = "name,asset_type\nGood Asset,real_estate\n,vehicle";
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([makeAsset()]),
    };
    const db = { insert: vi.fn().mockReturnValue(insertMock) } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/assets/import-csv")
      .send({ companyId: "company-1", csv: badCsv });

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatch(/Row 3/);
  });

  it("returns 0 imported for empty CSV", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/assets/import-csv")
      .send({ companyId: "company-1", csv: "name,asset_type" });

    // route returns 200 (not 201) when there's nothing to insert
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
  });

  it("returns 400 when csv field is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/assets/import-csv")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Financial accounts
// ---------------------------------------------------------------------------

describe("GET /estate/financial-accounts", () => {
  it("returns accounts list excluding plaidAccessToken", async () => {
    // The route explicitly selects columns, omitting plaidAccessToken.
    // The mock simulates a DB that only returns the selected columns.
    const accountWithoutToken = makeAccount();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([accountWithoutToken]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/financial-accounts?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    // plaidAccessToken is not included in makeAccount() — confirms it's never in the response
    expect(res.body.accounts[0].plaidAccessToken).toBeUndefined();
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await request(createApp({} as unknown as Db)).get("/estate/financial-accounts");
    expect(res.status).toBe(400);
  });
});

describe("POST /estate/financial-accounts", () => {
  it("creates a manual account with initial balance and records history", async () => {
    const account = makeAccount();
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValueOnce([account]).mockResolvedValue([]),
    };
    const db = {
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/financial-accounts")
      .send({ companyId: "company-1", name: "Checking", accountType: "checking", balanceCents: 500000 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Checking");
    // two inserts: account + balance history
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("creates account without balance and skips history insert", async () => {
    const account = makeAccount({ balanceCents: null });
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([account]),
    };
    const db = {
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/financial-accounts")
      .send({ companyId: "company-1", name: "Savings", accountType: "savings" });

    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when accountType is missing", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/estate/financial-accounts")
      .send({ companyId: "company-1", name: "X" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /estate/financial-accounts/:accountId", () => {
  it("updates balance and records history when balance changes", async () => {
    const existing = makeAccount({ balanceCents: "100000" });
    const updated = { ...existing, balanceCents: "200000" };
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])) }),
      update: vi.fn().mockReturnValue(updateMock),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/financial-accounts/account-1")
      .send({ balanceCents: 200000 });

    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("does not insert balance history when balance is unchanged", async () => {
    const existing = makeAccount({ balanceCents: "100000" });
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([existing]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([existing])) }),
      update: vi.fn().mockReturnValue(updateMock),
      insert: vi.fn(),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/financial-accounts/account-1")
      .send({ name: "New Name" });

    expect(res.status).toBe(200);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown account", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])) }),
    } as unknown as Db;
    const res = await request(createApp(db)).patch("/estate/financial-accounts/missing").send({});
    expect(res.status).toBe(404);
  });
});

describe("GET /estate/financial-accounts/:accountId/balance-history", () => {
  it("returns balance history for a valid account", async () => {
    const history = [
      { id: "h-1", accountId: "account-1", balanceCents: "500000", recordedAt: NOW },
    ];
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue(history),
      // first call resolves with account for access check, second with history
    } as unknown as Db;

    // Override to distinguish the two calls
    let callCount = 0;
    (db as any).where = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([{ companyId: "company-1" }])) };
      }
      return { orderBy: vi.fn().mockResolvedValue(history) };
    });

    const res = await request(createApp(db)).get("/estate/financial-accounts/account-1/balance-history");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it("returns 404 for unknown account", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: (fn: (r: unknown[]) => unknown) => Promise.resolve(fn([])) }),
    } as unknown as Db;
    const res = await request(createApp(db)).get("/estate/financial-accounts/missing/balance-history");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

describe("GET /estate/net-worth", () => {
  it("returns aggregated net worth with breakdown", async () => {
    // Query sequence:
    //   1. select().from(estateAssets).where()           → asset total sum
    //   2. select().from(estateFinancialAccounts).where() → account total sum
    //   3. select({cols}).from(estateFinancialAccounts).where() → account list
    //   4. select().from(estateAssets).where().groupBy() → breakdown (where is NOT terminal)
    //
    // where() must return a Promise for calls 1-3 and a {groupBy} stub for call 4.
    let whereCall = 0;
    const whereResults = [
      [{ total: "50000000" }],  // asset sum
      [{ total: "500000" }],    // account sum
      [makeAccount()],          // account list
    ];
    const breakdownStub = {
      groupBy: vi.fn().mockResolvedValue([{ assetType: "real_estate", totalCents: "50000000" }]),
    };
    const db: Db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const n = whereCall++;
        return n < 3 ? Promise.resolve(whereResults[n]) : breakdownStub;
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/net-worth?companyId=company-1");
    expect(res.status).toBe(200);
    expect(typeof res.body.netWorthDollars).toBe("number");
    expect(res.body.netWorthDollars).toBeCloseTo(505000, 0);
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(Array.isArray(res.body.assetBreakdown)).toBe(true);
    expect(res.body.assetBreakdown[0].assetType).toBe("real_estate");
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await request(createApp({} as unknown as Db)).get("/estate/net-worth");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Plaid webhook
// ---------------------------------------------------------------------------

describe("POST /estate/plaid/webhook", () => {
  it("ignores unknown webhook types and returns received: true", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/estate/plaid/webhook")
      .send({ webhook_type: "INCOME", webhook_code: "WHATEVER" });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("updates balances when TRANSACTIONS DEFAULT_UPDATE arrives", async () => {
    const account = makeAccount({ plaidItemId: "item-123" });
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([account]),
      update: vi.fn().mockReturnValue(updateMock),
      insert: vi.fn().mockReturnValue(insertMock),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/plaid/webhook")
      .send({
        webhook_type: "TRANSACTIONS",
        webhook_code: "DEFAULT_UPDATE",
        item_id: "item-123",
        new_webhook_payload: { balance_cents: 750000 },
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(db.update).toHaveBeenCalledOnce();
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("skips balance update when balance_cents is not a number", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeAccount()]),
      update: vi.fn(),
      insert: vi.fn(),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/plaid/webhook")
      .send({
        webhook_type: "TRANSACTIONS",
        webhook_code: "DEFAULT_UPDATE",
        item_id: "item-123",
        new_webhook_payload: { balance_cents: "not-a-number" },
      });

    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe("estate routes auth enforcement", () => {
  it("returns 403 when actor is not board type", async () => {
    const db = {} as unknown as Db;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "none" } as any;
      next();
    });
    app.use(estateRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get("/estate/assets?companyId=company-1");
    expect(res.status).toBe(403);
  });
});
