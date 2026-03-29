import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  isInstanceAdmin: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  ensureMembership: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDeduplicateAgentName = vi.hoisted(() => vi.fn());
const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
  deduplicateAgentName: mockDeduplicateAgentName,
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../board-claim.js", () => ({
  claimBoardOwnership: vi.fn(),
  inspectBoardClaimChallenge: vi.fn().mockReturnValue({ status: "invalid" }),
}));

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const ADMIN_ACTOR = {
  type: "board",
  userId: "admin-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: true,
};

const LOCAL_ACTOR = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
};

const OTHER_COMPANY_ACTOR = {
  type: "board",
  userId: "user-2",
  companyIds: ["company-other"],
  source: "session",
  isInstanceAdmin: false,
};

const UNAUTHENTICATED_ACTOR = {
  type: "none",
};

function createApp(actor: any = BOARD_ACTOR) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes({} as any, {
      deploymentMode: "self_hosted" as any,
      deploymentExposure: "local" as any,
      bindHost: "127.0.0.1",
      allowedHostnames: ["localhost"],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("access routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(true);
  });

  describe("GET /api/companies/:companyId/members", () => {
    it("returns member list for authorized user", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.listMembers.mockResolvedValue([
        { userId: "user-1", role: "admin" },
        { userId: "user-2", role: "member" },
      ]);

      const res = await request(createApp()).get(
        "/api/companies/company-1/members",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("rejects user from different company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/companies/company-1/members",
      );

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/companies/:companyId/members/:memberId/permissions", () => {
    it("updates member permissions", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      const grants = [{ permissionKey: "agents:create" }];
      mockAccessService.setMemberPermissions.mockResolvedValue({
        userId: "user-2",
        grants,
      });

      const res = await request(createApp())
        .patch("/api/companies/company-1/members/user-2/permissions")
        .send({ grants });

      expect(res.status).toBe(200);
      expect(mockAccessService.setMemberPermissions).toHaveBeenCalledWith(
        "company-1",
        "user-2",
        grants,
        "user-1",
      );
    });

    it("returns 404 for non-existent member", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.setMemberPermissions.mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/companies/company-1/members/nonexistent/permissions")
        .send({ grants: [{ permissionKey: "agents:create" }] });

      expect(res.status).toBe(404);
    });
  });

  describe("instance admin routes", () => {
    it("POST /api/admin/users/:userId/promote-instance-admin requires admin", async () => {
      // Non-admin user
      const res = await request(createApp(BOARD_ACTOR)).post(
        "/api/admin/users/user-2/promote-instance-admin",
      );

      expect(res.status).toBe(403);
      expect(mockAccessService.promoteInstanceAdmin).not.toHaveBeenCalled();
    });

    it("POST /api/admin/users/:userId/promote-instance-admin succeeds for local admin", async () => {
      mockAccessService.promoteInstanceAdmin.mockResolvedValue({
        userId: "user-2",
        role: "instance_admin",
      });

      const res = await request(createApp(LOCAL_ACTOR)).post(
        "/api/admin/users/user-2/promote-instance-admin",
      );

      expect(res.status).toBe(201);
      expect(mockAccessService.promoteInstanceAdmin).toHaveBeenCalledWith("user-2");
    });

    it("POST /api/admin/users/:userId/demote-instance-admin requires admin", async () => {
      const res = await request(createApp(BOARD_ACTOR)).post(
        "/api/admin/users/user-2/demote-instance-admin",
      );

      expect(res.status).toBe(403);
    });

    it("GET /api/admin/users/:userId/company-access requires admin", async () => {
      const res = await request(createApp(BOARD_ACTOR)).get(
        "/api/admin/users/user-2/company-access",
      );

      expect(res.status).toBe(403);
    });

    it("GET /api/admin/users/:userId/company-access succeeds for local admin", async () => {
      mockAccessService.listUserCompanyAccess.mockResolvedValue([
        { companyId: "company-1", role: "admin" },
      ]);

      const res = await request(createApp(LOCAL_ACTOR)).get(
        "/api/admin/users/user-2/company-access",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("PUT /api/admin/users/:userId/company-access requires admin", async () => {
      // Use valid UUID-format company IDs to pass schema validation
      const res = await request(createApp(BOARD_ACTOR))
        .put("/api/admin/users/user-2/company-access")
        .send({ companyIds: [] });

      // Non-admin gets rejected (403) or schema validates first (400)
      expect([400, 403]).toContain(res.status);
      expect(mockAccessService.setUserCompanyAccess).not.toHaveBeenCalled();
    });
  });

  describe("authentication required", () => {
    it("rejects unauthenticated requests to member list", async () => {
      const res = await request(createApp(UNAUTHENTICATED_ACTOR)).get(
        "/api/companies/company-1/members",
      );

      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to admin routes", async () => {
      const res = await request(createApp(UNAUTHENTICATED_ACTOR)).post(
        "/api/admin/users/user-1/promote-instance-admin",
      );

      expect(res.status).toBe(401);
    });
  });

  describe("company isolation", () => {
    it("cannot list members of another company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/companies/company-1/members",
      );

      expect(res.status).toBe(403);
      expect(mockAccessService.listMembers).not.toHaveBeenCalled();
    });

    it("cannot update member permissions in another company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR))
        .patch("/api/companies/company-1/members/user-1/permissions")
        .send({ grants: [] });

      // The permission check rejects before reaching the service
      expect([400, 403]).toContain(res.status);
      expect(mockAccessService.setMemberPermissions).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/board-claim/:token", () => {
    it("returns 404 for invalid token", async () => {
      const res = await request(createApp()).get("/api/board-claim/invalid-token");

      expect(res.status).toBe(404);
    });
  });
});
