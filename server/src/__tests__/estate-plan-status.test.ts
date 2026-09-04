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
    maritalStatus: "married",
    stateOfResidence: "CA",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Builds a db mock for GET /estates/:estateId/plan-status.
 *
 * The route makes:
 *   1. estate lookup (sequential)
 *   2-7. 6 parallel selects via Promise.all:
 *        documents, trusts, beneficiaries, insurance, retirement, reviews
 *
 * All .where() calls return Promise.resolve(results[idx++]) so the same
 * mock works whether the caller uses .then() or await.
 */
function makePlanStatusDb(
  estate: Record<string, unknown>,
  documents: object[],
  trusts: object[],
  beneficiaries: object[],
  insurance: object[],
  retirement: object[],
  reviews: object[],
): Db {
  const results = [
    [estate],
    documents,
    trusts,
    beneficiaries,
    insurance,
    retirement,
    reviews,
  ];
  let idx = 0;
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => Promise.resolve(results[idx++] ?? [])),
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /estates/:estateId/plan-status", () => {
  it("returns a perfect score when all checks pass", async () => {
    const estate = makeEstate();
    const db = makePlanStatusDb(
      estate,
      [
        { documentType: "will" },
        { documentType: "poa" },
        { documentType: "healthcare_directive" },
      ],
      [{ id: "trust-1" }],
      [{ id: "ben-1" }],
      [{ id: "ins-1" }],
      [{ id: "ret-1" }],
      [{ status: "complete" }],
    );

    const res = await request(createApp(db)).get("/estates/estate-1/plan-status");

    expect(res.status).toBe(200);
    expect(res.body.estateId).toBe("estate-1");
    expect(res.body.estateName).toBe("Smith Family Estate");
    expect(res.body.score).toBe(100);
    expect(res.body.completedCount).toBe(9);
    expect(res.body.totalChecks).toBe(9);
    expect(res.body.checks.hasWill).toBe(true);
    expect(res.body.checks.hasTrust).toBe(true);
    expect(res.body.checks.hasPOA).toBe(true);
    expect(res.body.checks.hasHealthcareDirective).toBe(true);
    expect(res.body.checks.hasInsurance).toBe(true);
    expect(res.body.checks.hasRetirementAccount).toBe(true);
    expect(res.body.checks.hasBeneficiaries).toBe(true);
    expect(res.body.checks.hasAnnualReview).toBe(true);
    expect(res.body.checks.hasDocumentVault).toBe(true);
    expect(res.body.missingItems).toHaveLength(0);
    expect(res.body.completedItems).toHaveLength(9);
  });

  it("returns a zero score when nothing is set up", async () => {
    const estate = makeEstate();
    const db = makePlanStatusDb(estate, [], [], [], [], [], []);

    const res = await request(createApp(db)).get("/estates/estate-1/plan-status");

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.completedCount).toBe(0);
    expect(res.body.missingItems).toHaveLength(9);
    expect(res.body.completedItems).toHaveLength(0);
    expect(res.body.checks.hasWill).toBe(false);
    expect(res.body.checks.hasTrust).toBe(false);
    expect(res.body.checks.hasBeneficiaries).toBe(false);
  });

  it("returns partial score when some checks pass", async () => {
    const estate = makeEstate();
    const db = makePlanStatusDb(
      estate,
      [{ documentType: "will" }],
      [{ id: "trust-1" }],
      [],
      [],
      [],
      [],
    );

    const res = await request(createApp(db)).get("/estates/estate-1/plan-status");

    expect(res.status).toBe(200);
    // hasWill + hasTrust + hasDocumentVault = 3 of 9 → 33%
    expect(res.body.checks.hasWill).toBe(true);
    expect(res.body.checks.hasTrust).toBe(true);
    expect(res.body.checks.hasDocumentVault).toBe(true);
    expect(res.body.checks.hasBeneficiaries).toBe(false);
    expect(res.body.checks.hasInsurance).toBe(false);
    expect(res.body.completedCount).toBe(3);
    expect(res.body.score).toBe(33);
  });

  it("marks hasAnnualReview false when review status is not complete", async () => {
    const estate = makeEstate();
    const db = makePlanStatusDb(
      estate,
      [],
      [],
      [],
      [],
      [],
      [{ status: "in_progress" }],
    );

    const res = await request(createApp(db)).get("/estates/estate-1/plan-status");

    expect(res.status).toBe(200);
    expect(res.body.checks.hasAnnualReview).toBe(false);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(Promise.resolve([])),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estates/unknown/plan-status");

    expect(res.status).toBe(404);
  });

  it("returns 403 when actor is not board type", async () => {
    const estate = makeEstate();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(Promise.resolve([estate])),
    } as unknown as Db;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "none" } as ReturnType<typeof boardActor>;
      next();
    });
    app.use(estateRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get("/estates/estate-1/plan-status");

    expect(res.status).toBe(403);
  });
});
