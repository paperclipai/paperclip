import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const NEW_COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn(async (body: any) => ({ id: NEW_COMPANY_ID, name: body.name, budgetMonthlyCents: 0 })),
}));
const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(async () => {}),
  ensureRoleDefaultGrants: vi.fn(async () => {}),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ allowSelfServiceCompanyCreation: false })),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  agentService: () => ({}),
  companyPortabilityService: () => ({}),
  accessService: () => mockAccessService,
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  instanceSettingsService: () => mockInstanceSettingsService,
  feedbackService: () => ({}),
  logActivity: vi.fn(async () => {}),
}));

import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

let currentActor: Record<string, unknown>;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const nonAdmin = {
  type: "board",
  source: "authenticated",
  userId: "user-new",
  isInstanceAdmin: false,
  companyIds: [],
  memberships: [],
};
const instanceAdmin = { ...nonAdmin, userId: "owner", isInstanceAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockInstanceSettingsService.getGeneral.mockResolvedValue({ allowSelfServiceCompanyCreation: false });
});

describe("self-service company creation gate", () => {
  it("rejects a non-admin when self-service is disabled (403)", async () => {
    currentActor = nonAdmin;
    const res = await request(buildApp()).post("/api/companies").send({ name: "My Startup" });
    expect(res.status).toBe(403);
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("allows a non-admin when self-service is enabled, granting them ownership (201)", async () => {
    currentActor = nonAdmin;
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ allowSelfServiceCompanyCreation: true });
    const res = await request(buildApp()).post("/api/companies").send({ name: "My Startup" });
    expect(res.status).toBe(201);
    expect(mockCompanyService.create).toHaveBeenCalled();
    // Creator becomes the owner of the new company.
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      NEW_COMPANY_ID,
      "user",
      "user-new",
      "owner",
      "active",
    );
  });

  it("always allows the instance admin, even when self-service is disabled (201)", async () => {
    currentActor = instanceAdmin;
    const res = await request(buildApp()).post("/api/companies").send({ name: "Owner Co" });
    expect(res.status).toBe(201);
    expect(mockCompanyService.create).toHaveBeenCalled();
    // Admin path must not even consult the self-service flag.
    expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
  });
});
