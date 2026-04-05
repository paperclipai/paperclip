import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn().mockResolvedValue(false),
  getMembership: vi.fn(),
  hasPermission: vi.fn().mockResolvedValue(false),
  canUser: vi.fn().mockResolvedValue(false),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../board-claim.js", () => ({
  inspectBoardClaimChallenge: vi.fn(),
  claimBoardOwnership: vi.fn(),
}));

const defaultOpts = {
  deploymentMode: "local_trusted" as const,
  deploymentExposure: "private" as const,
  bindHost: "127.0.0.1",
  allowedHostnames: [],
};

/** Board user scoped to company-a only, non-admin. */
function createAppForBoardCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-a",
      companyIds: ["company-a"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", accessRoutes({} as any, defaultOpts));
  app.use(errorHandler);
  return app;
}

/** Agent scoped to company-a. */
function createAppForAgentCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-a",
      companyId: "company-a",
      source: "agent_key",
    };
    next();
  });
  app.use("/api", accessRoutes({} as any, defaultOpts));
  app.use(errorHandler);
  return app;
}

describe("access routes: cross-company isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  describe("board user scoped to company-a", () => {
    it("GET /companies/company-b/join-requests returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).get(
        "/api/companies/company-b/join-requests",
      );

      expect(res.status).toBe(403);
    });

    it("POST /companies/company-b/join-requests/:id/approve returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).post(
        "/api/companies/company-b/join-requests/req-1/approve",
      );

      expect(res.status).toBe(403);
    });

    it("POST /companies/company-b/join-requests/:id/reject returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).post(
        "/api/companies/company-b/join-requests/req-1/reject",
      );

      expect(res.status).toBe(403);
    });

    it("GET /companies/company-b/members returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).get(
        "/api/companies/company-b/members",
      );

      expect(res.status).toBe(403);
    });

    it("PATCH /companies/company-b/members/:id/permissions returns 403", async () => {
      const res = await request(createAppForBoardCompanyA())
        .patch("/api/companies/company-b/members/member-1/permissions")
        .send({ grants: [] });

      expect(res.status).toBe(403);
    });

    it("POST /companies/company-b/invites returns 403", async () => {
      const res = await request(createAppForBoardCompanyA())
        .post("/api/companies/company-b/invites")
        .send({ allowedJoinTypes: "agent" });

      expect(res.status).toBe(403);
    });
  });

  describe("agent scoped to company-a", () => {
    it("GET /companies/company-b/join-requests returns 403 for agent", async () => {
      const res = await request(createAppForAgentCompanyA()).get(
        "/api/companies/company-b/join-requests",
      );

      expect(res.status).toBe(403);
    });

    it("GET /companies/company-b/members returns 403 for agent", async () => {
      const res = await request(createAppForAgentCompanyA()).get(
        "/api/companies/company-b/members",
      );

      expect(res.status).toBe(403);
    });

    it("POST /companies/company-b/invites returns 403 for agent", async () => {
      const res = await request(createAppForAgentCompanyA())
        .post("/api/companies/company-b/invites")
        .send({ allowedJoinTypes: "agent" });

      expect(res.status).toBe(403);
    });
  });

  describe("admin routes reject non-admin board users", () => {
    it("POST /admin/users/:userId/promote-instance-admin returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).post(
        "/api/admin/users/user-x/promote-instance-admin",
      );

      expect(res.status).toBe(403);
      expect(mockAccessService.promoteInstanceAdmin).not.toHaveBeenCalled();
    });

    it("POST /admin/users/:userId/demote-instance-admin returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).post(
        "/api/admin/users/user-x/demote-instance-admin",
      );

      expect(res.status).toBe(403);
      expect(mockAccessService.demoteInstanceAdmin).not.toHaveBeenCalled();
    });

    it("GET /admin/users/:userId/company-access returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).get(
        "/api/admin/users/user-x/company-access",
      );

      expect(res.status).toBe(403);
      expect(mockAccessService.listUserCompanyAccess).not.toHaveBeenCalled();
    });

    it("PUT /admin/users/:userId/company-access returns 403", async () => {
      const res = await request(createAppForBoardCompanyA())
        .put("/api/admin/users/user-x/company-access")
        .send({ companyIds: ["00000000-0000-0000-0000-000000000001"] });

      expect(res.status).toBe(403);
      expect(mockAccessService.setUserCompanyAccess).not.toHaveBeenCalled();
    });
  });

  describe("agent cannot access admin routes", () => {
    it("POST /admin/users/:userId/promote-instance-admin returns 401 for agent", async () => {
      const res = await request(createAppForAgentCompanyA()).post(
        "/api/admin/users/user-x/promote-instance-admin",
      );

      expect(res.status).toBe(401);
    });
  });
});
