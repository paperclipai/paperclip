import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes, type AttomClient } from "../routes/estate.js";
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

function createApp(db: Db, attomClient?: AttomClient | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor();
    next();
  });
  app.use(estateRoutes(db, undefined, undefined, attomClient));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    name: "123 Main St",
    assetType: "real_estate",
    category: null,
    tags: null,
    entityId: null,
    currentValueCents: "50000000",
    valuationDate: NOW,
    typeMetadata: { address: "123 Main St", city: "Springfield", state: "IL", zip: "62701" },
    estateId: null,
    notes: null,
    attomPropertyId: null,
    assessedValueCents: null,
    valuationSource: "manual",
    attomEnrichedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAttomDetail(overrides: Record<string, unknown> = {}) {
  return {
    attomId: "attom-prop-123",
    assessedValueCents: 45000000,
    marketValueCents: 52000000,
    squareFeet: 2000,
    lotSizeSqFt: 6000,
    yearBuilt: 1985,
    bedrooms: 3,
    bathrooms: 2,
    ownerName: "John Smith",
    legalDescription: "LOT 5 BLK 3 SPRINGFIELD SUBDIVISION",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /estate/assets/:assetId/attom/enrich
// ---------------------------------------------------------------------------

describe("POST /estate/assets/:assetId/attom/enrich", () => {
  it("enriches a real_estate asset with ATTOM data and returns updated asset", async () => {
    const asset = makeAsset();
    const detail = makeAttomDetail();

    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn().mockResolvedValue(detail),
    };

    const enriched = {
      ...asset,
      attomPropertyId: "attom-prop-123",
      assessedValueCents: "45000000",
      valuationSource: "attom",
      attomEnrichedAt: NOW,
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([asset]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([enriched]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db, attomClient))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.attomPropertyId).toBe("attom-prop-123");
    expect(res.body.assessedValueCents).toBe("45000000");
    expect(res.body.valuationSource).toBe("attom");
    expect(attomClient.getPropertyByAddress).toHaveBeenCalledWith(
      expect.stringContaining("123 Main St"),
      expect.stringContaining("Springfield"),
    );
  });

  it("uses address from request body when provided, ignoring typeMetadata", async () => {
    const asset = makeAsset({ typeMetadata: {} });
    const detail = makeAttomDetail();

    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn().mockResolvedValue(detail),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([asset]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...asset, attomPropertyId: "attom-prop-123", valuationSource: "attom" }]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db, attomClient))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1", address1: "456 Oak Ave", address2: "Chicago, IL 60601" });

    expect(res.status).toBe(200);
    expect(attomClient.getPropertyByAddress).toHaveBeenCalledWith("456 Oak Ave", "Chicago, IL 60601");
  });

  it("returns 404 when asset does not exist", async () => {
    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db, attomClient))
      .post("/estate/assets/nonexistent/attom/enrich")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(404);
  });

  it("returns 400 when companyId is missing", async () => {
    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn(),
    };

    const res = await request(createApp({} as unknown as Db, attomClient))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when asset has no address and no address provided in body", async () => {
    const asset = makeAsset({ typeMetadata: {} });
    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([asset]),
    } as unknown as Db;

    const res = await request(createApp(db, attomClient))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
  });

  it("returns 422 when ATTOM returns no property match", async () => {
    const asset = makeAsset();
    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn().mockResolvedValue(null),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([asset]),
    } as unknown as Db;

    const res = await request(createApp(db, attomClient))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no property/i);
  });

  it("returns 503 when no ATTOM client is configured", async () => {
    const res = await request(createApp({} as unknown as Db, null))
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("returns 403 when actor is not board type", async () => {
    const attomClient: AttomClient = {
      getPropertyByAddress: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1" } as never;
      next();
    });
    app.use(estateRoutes({} as unknown as Db, undefined, undefined, attomClient));
    app.use(errorHandler);

    const res = await request(app)
      .post("/estate/assets/asset-1/attom/enrich")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(403);
  });
});
