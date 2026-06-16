import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockBillingService = vi.hoisted(() => ({
  getOrCreateAccount: vi.fn(async (companyId: string) => ({ companyId, markupBps: 0, currency: "usd", status: "active" })),
  updateAccount: vi.fn(async (companyId: string, patch: any) => ({ companyId, markupBps: patch.markupBps ?? 0, currency: "usd", status: "active" })),
  computeStatement: vi.fn(async (companyId: string) => ({ companyId, rawCostCents: 0, billableCostCents: 0, lineItems: [] })),
}));

vi.mock("../services/index.js", () => ({
  billingService: () => mockBillingService,
  logActivity: vi.fn(async () => {}),
}));

import { errorHandler } from "../middleware/index.js";
import { billingRoutes } from "../routes/billing.js";

let currentActor: Record<string, unknown>;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", billingRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// Board member of COMPANY only; not an instance admin.
const tenantMember = {
  type: "board",
  source: "authenticated",
  userId: "u-tenant",
  isInstanceAdmin: false,
  companyIds: [COMPANY],
  memberships: [{ companyId: COMPANY, role: "owner", status: "active" }],
};
const instanceAdmin = { ...tenantMember, userId: "u-admin", isInstanceAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billing routes authz", () => {
  it("lets a tenant read their own billing account", async () => {
    currentActor = tenantMember;
    const res = await request(buildApp()).get(`/api/companies/${COMPANY}/billing/account`);
    expect(res.status).toBe(200);
    expect(mockBillingService.getOrCreateAccount).toHaveBeenCalledWith(COMPANY);
  });

  it("denies a tenant reading another company's account", async () => {
    currentActor = tenantMember;
    const res = await request(buildApp()).get(`/api/companies/${OTHER}/billing/account`);
    expect(res.status).toBe(403);
    expect(mockBillingService.getOrCreateAccount).not.toHaveBeenCalled();
  });

  it("denies a non-admin tenant from setting the markup", async () => {
    currentActor = tenantMember;
    const res = await request(buildApp())
      .patch(`/api/companies/${COMPANY}/billing/account`)
      .send({ markupBps: 5000 });
    expect(res.status).toBe(403);
    expect(mockBillingService.updateAccount).not.toHaveBeenCalled();
  });

  it("lets the instance admin set the markup", async () => {
    currentActor = instanceAdmin;
    const res = await request(buildApp())
      .patch(`/api/companies/${COMPANY}/billing/account`)
      .send({ markupBps: 2000 });
    expect(res.status).toBe(200);
    expect(mockBillingService.updateAccount).toHaveBeenCalledWith(COMPANY, { markupBps: 2000 });
  });

  it("lets a tenant read their own statement", async () => {
    currentActor = tenantMember;
    const res = await request(buildApp()).get(`/api/companies/${COMPANY}/billing/statement`);
    expect(res.status).toBe(200);
    expect(mockBillingService.computeStatement).toHaveBeenCalled();
  });
});
