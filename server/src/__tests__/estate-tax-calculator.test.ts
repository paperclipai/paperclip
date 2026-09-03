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

function makeEstate(overrides: Record<string, unknown> = {}) {
  return {
    id: "estate-1",
    companyId: "company-1",
    ownerUserId: "user-1",
    name: "Smith Family Estate",
    estateType: "individual",
    maritalStatus: "single",
    stateOfResidence: "CA",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Builds a db mock for GET /estates/:estateId/tax-summary.
 * The route makes 3 sequential select queries:
 *   1. estates lookup (single row)
 *   2. estateAssets aggregate (returns { total: string })
 *   3. estateFinancialAccounts aggregate (returns { total: string })
 */
function buildTaxSummaryDb(
  estate: ReturnType<typeof makeEstate>,
  assetsTotalCents: number,
  accountsTotalCents: number,
): Db {
  let callCount = 0;
  const whereMock = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([estate]);
    if (callCount === 2) return Promise.resolve([{ total: String(assetsTotalCents) }]);
    return Promise.resolve([{ total: String(accountsTotalCents) }]);
  });

  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: whereMock,
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/tax-summary", () => {
  // 2026 OBBBA exemptions
  const INDIVIDUAL_EXEMPTION_CENTS = 1_500_000_000; // $15M
  const MARRIED_EXEMPTION_CENTS = 3_000_000_000;    // $30M

  it("returns zero tax when gross estate is below the individual exemption", async () => {
    // $10M estate — below $15M exemption
    const estate = makeEstate({ maritalStatus: "single" });
    const db = buildTaxSummaryDb(estate, 1_000_000_000, 0); // $10M in assets
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.grossEstateCents).toBe(1_000_000_000);
    expect(res.body.grossEstateDollars).toBe(10_000_000);
    expect(res.body.federalExemptionCents).toBe(INDIVIDUAL_EXEMPTION_CENTS);
    expect(res.body.federalExemptionDollars).toBe(15_000_000);
    expect(res.body.taxableEstateCents).toBe(0);
    expect(res.body.taxableEstateDollars).toBe(0);
    expect(res.body.estimatedFederalTaxCents).toBe(0);
    expect(res.body.estimatedFederalTaxDollars).toBe(0);
    expect(res.body.taxRate).toBe(0.4);
    expect(res.body.exemptionYear).toBe(2026);
    expect(res.body.exemptionLaw).toBe("OBBBA 2026");
  });

  it("computes 40% tax on amount above individual exemption", async () => {
    // $20M estate, single → taxable = $5M → tax = $2M
    const estate = makeEstate({ maritalStatus: "single" });
    const db = buildTaxSummaryDb(estate, 2_000_000_000, 0); // $20M
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.grossEstateCents).toBe(2_000_000_000);
    expect(res.body.federalExemptionCents).toBe(INDIVIDUAL_EXEMPTION_CENTS);
    expect(res.body.taxableEstateCents).toBe(500_000_000);  // $5M
    expect(res.body.estimatedFederalTaxCents).toBe(200_000_000); // $2M
    expect(res.body.estimatedFederalTaxDollars).toBe(2_000_000);
  });

  it("uses $30M exemption for married marital status", async () => {
    // $25M estate, married → below $30M exemption → no tax
    const estate = makeEstate({ maritalStatus: "married" });
    const db = buildTaxSummaryDb(estate, 2_500_000_000, 0); // $25M
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.federalExemptionCents).toBe(MARRIED_EXEMPTION_CENTS);
    expect(res.body.taxableEstateCents).toBe(0);
    expect(res.body.estimatedFederalTaxCents).toBe(0);
  });

  it("uses $30M exemption for domestic_partnership marital status", async () => {
    const estate = makeEstate({ maritalStatus: "domestic_partnership" });
    const db = buildTaxSummaryDb(estate, 3_500_000_000, 0); // $35M
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.federalExemptionCents).toBe(MARRIED_EXEMPTION_CENTS);
    // taxable = $35M - $30M = $5M; tax = $2M
    expect(res.body.taxableEstateCents).toBe(500_000_000);
    expect(res.body.estimatedFederalTaxCents).toBe(200_000_000);
  });

  it("uses $15M exemption for divorced marital status", async () => {
    const estate = makeEstate({ maritalStatus: "divorced" });
    const db = buildTaxSummaryDb(estate, 2_000_000_000, 0); // $20M
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.federalExemptionCents).toBe(INDIVIDUAL_EXEMPTION_CENTS);
    expect(res.body.taxableEstateCents).toBe(500_000_000);
  });

  it("uses $15M exemption for widowed marital status", async () => {
    const estate = makeEstate({ maritalStatus: "widowed" });
    const db = buildTaxSummaryDb(estate, 2_000_000_000, 0); // $20M
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.federalExemptionCents).toBe(INDIVIDUAL_EXEMPTION_CENTS);
  });

  it("uses $15M exemption when marital status is null", async () => {
    const estate = makeEstate({ maritalStatus: null });
    const db = buildTaxSummaryDb(estate, 2_000_000_000, 0);
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.federalExemptionCents).toBe(INDIVIDUAL_EXEMPTION_CENTS);
  });

  it("includes financial account balances in gross estate", async () => {
    // $10M in assets + $8M in financial accounts = $18M gross
    // $18M - $15M exemption = $3M taxable → $1.2M tax
    const estate = makeEstate({ maritalStatus: "single" });
    const db = buildTaxSummaryDb(estate, 1_000_000_000, 800_000_000);
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.grossEstateCents).toBe(1_800_000_000);       // $18M
    expect(res.body.taxableEstateCents).toBe(300_000_000);        // $3M
    expect(res.body.estimatedFederalTaxCents).toBe(120_000_000);  // $1.2M
    expect(res.body.estimatedFederalTaxDollars).toBe(1_200_000);
  });

  it("returns estate metadata in response", async () => {
    const estate = makeEstate({ name: "Jones Estate", maritalStatus: "married" });
    const db = buildTaxSummaryDb(estate, 0, 0);
    const app = createApp(db);

    const res = await request(app).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(200);
    expect(res.body.estateId).toBe("estate-1");
    expect(res.body.estateName).toBe("Jones Estate");
    expect(res.body.maritalStatus).toBe("married");
    expect(res.body.asOfDate).toBeTruthy();
  });

  it("returns 404 when estate does not exist", async () => {
    const whereMock = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereMock,
    } as unknown as Db;

    const app = createApp(db);
    const res = await request(app).get("/estates/nonexistent/tax-summary");

    expect(res.status).toBe(404);
  });

  it("returns 403 when estate belongs to a different company (non-local actor)", async () => {
    // local_implicit actors bypass company checks; use a real board session to test 403
    const estate = makeEstate({ companyId: "company-2" });
    const whereMock = vi.fn().mockResolvedValue([estate]);
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereMock,
    } as unknown as Db;

    const appWithApiActor = express();
    appWithApiActor.use(express.json());
    appWithApiActor.use((req, _res, next) => {
      req.actor = {
        type: "board" as const,
        source: "api_key" as const,
        userId: "user-1",
        companyIds: ["company-1"],
      };
      next();
    });
    appWithApiActor.use(estateRoutes(db));
    appWithApiActor.use(errorHandler);

    const res = await request(appWithApiActor).get("/estates/estate-1/tax-summary");

    expect(res.status).toBe(403);
  });
});
