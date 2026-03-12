import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../../routes/access.js";
import { errorHandler } from "../../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  isInstanceAdmin: vi.fn(),
  canModifyMember: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  removeMember: vi.fn(),
  suspendMember: vi.fn(),
  unsuspendMember: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockDeduplicateAgentName = vi.hoisted(() => vi.fn().mockImplementation((name: string) => name));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  deduplicateAgentName: mockDeduplicateAgentName,
  logActivity: mockLogActivity,
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../board-claim.js", () => ({
  claimBoardOwnership: vi.fn().mockResolvedValue({ status: "claimed", claimedByUserId: "user-1" }),
  inspectBoardClaimChallenge: vi.fn().mockReturnValue({
    status: "available", requiresSignIn: true, expiresAt: null, claimedByUserId: null,
  }),
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", accessRoutes({} as any, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    bindHost: "0.0.0.0",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

describe("accessRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue({ granted: true });
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.canModifyMember.mockReturnValue(true);
  });

  describe("GET /skills/index", () => {
    it("returns skill list", async () => {
      const res = await request(createApp()).get("/api/skills/index");
      expect(res.status).toBe(200);
      expect(res.body.skills).toHaveLength(2);
    });
  });

  describe("GET /companies/:companyId/members", () => {
    it("lists members", async () => {
      mockAccessService.listMembers.mockResolvedValue([{ id: "m1", principalId: "user-1" }]);
      const res = await request(createApp()).get("/api/companies/company-1/members");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 without users:manage_permissions", async () => {
      mockAccessService.canUser.mockResolvedValue(false);
      const app = createApp({ source: "session", isInstanceAdmin: false });
      // Reset mock after createApp to apply non-admin flow
      mockAccessService.isInstanceAdmin.mockResolvedValue(false);
      const res = await request(app).get("/api/companies/company-1/members");
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /companies/:companyId/members/:memberId/permissions", () => {
    it("updates member permissions", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "contributor" },
      ]);
      mockAccessService.setMemberPermissions.mockResolvedValue({ id: "m2", grants: [] });
      const res = await request(createApp())
        .patch("/api/companies/company-1/members/m2/permissions")
        .send({ grants: [{ permissionKey: "agents:create" }] });
      expect(res.status).toBe(200);
    });

    it("returns 403 for lateral hierarchy violation", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "contributor" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "owner" },
      ]);
      mockAccessService.isInstanceAdmin.mockResolvedValue(false);
      mockAccessService.canModifyMember.mockReturnValue(false);
      const res = await request(createApp())
        .patch("/api/companies/company-1/members/m2/permissions")
        .send({ grants: [] });
      expect(res.status).toBe(403);
    });

    it("returns 404 for nonexistent member", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([]);
      const res = await request(createApp())
        .patch("/api/companies/company-1/members/missing/permissions")
        .send({ grants: [] });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /companies/:companyId/members/:memberId", () => {
    it("removes a member", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "contributor" },
      ]);
      mockAccessService.removeMember.mockResolvedValue(true);
      const res = await request(createApp())
        .delete("/api/companies/company-1/members/m2");
      expect(res.status).toBe(204);
    });

    it("returns 403 for hierarchy violation on delete", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "contributor" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "owner" },
      ]);
      mockAccessService.isInstanceAdmin.mockResolvedValue(false);
      mockAccessService.canModifyMember.mockReturnValue(false);
      const res = await request(createApp())
        .delete("/api/companies/company-1/members/m2");
      expect(res.status).toBe(403);
    });

    it("returns 404 for nonexistent member", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([]);
      const res = await request(createApp())
        .delete("/api/companies/company-1/members/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:companyId/members/:memberId/suspend", () => {
    it("suspends a member", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "contributor" },
      ]);
      mockAccessService.suspendMember.mockResolvedValue({ id: "m2", status: "suspended" });
      const res = await request(createApp())
        .post("/api/companies/company-1/members/m2/suspend");
      expect(res.status).toBe(200);
    });

    it("returns 403 for hierarchy violation on suspend", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "contributor" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "admin" },
      ]);
      mockAccessService.isInstanceAdmin.mockResolvedValue(false);
      mockAccessService.canModifyMember.mockReturnValue(false);
      const res = await request(createApp())
        .post("/api/companies/company-1/members/m2/suspend");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /companies/:companyId/members/:memberId/unsuspend", () => {
    it("unsuspends a member", async () => {
      mockAccessService.getMembership.mockResolvedValue({ membershipRole: "owner" });
      mockAccessService.listMembers.mockResolvedValue([
        { id: "m2", membershipRole: "contributor" },
      ]);
      mockAccessService.unsuspendMember.mockResolvedValue({ id: "m2", status: "active" });
      const res = await request(createApp())
        .post("/api/companies/company-1/members/m2/unsuspend");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /admin/users/:userId/promote-instance-admin", () => {
    it("promotes a user to instance admin", async () => {
      mockAccessService.promoteInstanceAdmin.mockResolvedValue({ id: "r1" });
      const res = await request(createApp({ isInstanceAdmin: true, source: "local_implicit" }))
        .post("/api/admin/users/user-2/promote-instance-admin");
      expect(res.status).toBe(201);
    });

    it("returns 401 for non-board actor", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a1", companyId: "company-1" }))
        .post("/api/admin/users/user-2/promote-instance-admin");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /admin/users/:userId/demote-instance-admin", () => {
    it("demotes a user from instance admin", async () => {
      mockAccessService.demoteInstanceAdmin.mockResolvedValue({ id: "r1" });
      const res = await request(createApp({ isInstanceAdmin: true, source: "local_implicit" }))
        .post("/api/admin/users/user-2/demote-instance-admin");
      expect(res.status).toBe(200);
    });

    it("returns 404 when role not found", async () => {
      mockAccessService.demoteInstanceAdmin.mockResolvedValue(null);
      const res = await request(createApp({ isInstanceAdmin: true, source: "local_implicit" }))
        .post("/api/admin/users/user-2/demote-instance-admin");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /admin/users/:userId/company-access", () => {
    it("returns user company access", async () => {
      mockAccessService.listUserCompanyAccess.mockResolvedValue([{ companyId: "company-1" }]);
      const res = await request(createApp({ isInstanceAdmin: true, source: "local_implicit" }))
        .get("/api/admin/users/user-2/company-access");
      expect(res.status).toBe(200);
    });
  });

  describe("PUT /admin/users/:userId/company-access", () => {
    it("sets user company access", async () => {
      mockAccessService.setUserCompanyAccess.mockResolvedValue([{ companyId: "00000000-0000-0000-0000-000000000001" }]);
      const res = await request(createApp({ isInstanceAdmin: true, source: "local_implicit" }))
        .put("/api/admin/users/user-2/company-access")
        .send({ companyIds: ["00000000-0000-0000-0000-000000000001"] });
      expect(res.status).toBe(200);
    });
  });
});
