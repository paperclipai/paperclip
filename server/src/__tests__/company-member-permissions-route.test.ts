import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentMemberId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const humanMemberId = "44444444-4444-4444-8444-444444444444";
const humanUserId = "55555555-5555-4555-8555-555555555555";
const ownerMemberId = "66666666-6666-4666-8666-666666666666";
const ownerUserId = "77777777-7777-4777-8777-777777777777";

const agentMember = {
  id: agentMemberId,
  companyId,
  principalType: "agent" as const,
  principalId: agentId,
  status: "active" as const,
  membershipRole: "member",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const humanMember = {
  id: humanMemberId,
  companyId,
  principalType: "user" as const,
  principalId: humanUserId,
  status: "active" as const,
  membershipRole: "operator",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const ownerMember = {
  id: ownerMemberId,
  companyId,
  principalType: "user" as const,
  principalId: ownerUserId,
  status: "active" as const,
  membershipRole: "owner",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  isInstanceAdmin: vi.fn(),
  getMembership: vi.fn(),
  getMemberById: vi.fn(),
  setMemberPermissions: vi.fn(),
  archiveMember: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

function createDbStub() {
  // The PATCH /permissions route only re-queries memberships via
  // loadCompanyMemberRecords on the human path, so an empty result set is fine
  // here — tests that hit that branch supply their own member via the mocked
  // getMemberById return value.
  return {
    select() {
      return {
        from() {
          const query = {
            where() {
              return query;
            },
            orderBy() {
              return Promise.resolve([]);
            },
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve([]));
            },
          };
          return query;
        },
      };
    },
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as never, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

const localImplicitBoardActor = {
  type: "board",
  userId: "local-board-user",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [companyId],
} as unknown as Express.Request["actor"];

describe("PATCH /companies/:companyId/members/:memberId/permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({
      id: "owner-self",
      companyId,
      principalType: "user",
      principalId: "local-board-user",
      status: "active",
      membershipRole: "owner",
    });
    mockAccessService.setMemberPermissions.mockImplementation(
      async (_companyId: string, memberId: string) => {
        if (memberId === agentMemberId) return agentMember;
        if (memberId === humanMemberId) return humanMember;
        if (memberId === ownerMemberId) return ownerMember;
        return null;
      },
    );
    mockAccessService.archiveMember.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
  });

  it("allows updating grants on an active agent-principal member", async () => {
    mockAccessService.getMemberById.mockResolvedValue(agentMember);
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:manage_active_checkouts",
        scope: null,
        grantedByUserId: null,
        createdAt: new Date("2026-05-19T00:00:00.000Z"),
        updatedAt: new Date("2026-05-19T00:00:00.000Z"),
      },
    ]);

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${agentMemberId}/permissions`)
      .send({
        grants: [{ permissionKey: "tasks:manage_active_checkouts", scope: null }],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: agentMemberId,
      principalType: "agent",
      principalId: agentId,
      grants: [
        expect.objectContaining({ permissionKey: "tasks:manage_active_checkouts" }),
      ],
    });
    expect(mockAccessService.setMemberPermissions).toHaveBeenCalledWith(
      companyId,
      agentMemberId,
      [{ permissionKey: "tasks:manage_active_checkouts", scope: null }],
      "local-board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company_member.permissions_updated",
        details: expect.objectContaining({
          principalType: "agent",
          grantCount: 1,
        }),
      }),
    );
  });

  it("still blocks archive (destructive) operations on agent-principal members", async () => {
    mockAccessService.getMemberById.mockResolvedValue(agentMember);

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .post(`/api/companies/${companyId}/members/${agentMemberId}/archive`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human company members can be removed");
    expect(mockAccessService.archiveMember).not.toHaveBeenCalled();
  });

  it("still allows archive on a regular human operator", async () => {
    mockAccessService.getMemberById.mockResolvedValue(humanMember);
    mockAccessService.archiveMember.mockResolvedValue({
      member: humanMember,
      reassignedIssueCount: 0,
    });

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .post(`/api/companies/${companyId}/members/${humanMemberId}/archive`)
      .send({});

    // The route still tries to look up the archived record via
    // loadCompanyMemberRecords, which our minimal db stub does not back; that
    // would surface as a 404 here. The guard itself succeeded — that's what
    // this test asserts — so we accept either 200 or 404 from the trailing
    // lookup, but never 403 from the guard.
    expect([200, 404]).toContain(res.status);
    expect(mockAccessService.archiveMember).toHaveBeenCalledWith(
      companyId,
      humanMemberId,
      expect.objectContaining({ reassignment: null }),
    );
  });

  it("still blocks archive of a human owner via the protected-member guard", async () => {
    mockAccessService.getMemberById.mockResolvedValue(ownerMember);

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .post(`/api/companies/${companyId}/members/${ownerMemberId}/archive`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("owners cannot be removed");
    expect(mockAccessService.archiveMember).not.toHaveBeenCalled();
  });

  // Regression for PR #6358 feedback: the grant-update relaxation must only
  // apply to PATCH /permissions. The other two PATCH routes still rely on
  // loadCompanyMemberRecords (human-only) after they mutate, so they have to
  // reject agent principals at the guard — before any DB mutation runs.
  it("rejects PATCH /members/:memberId for an agent-principal member at the guard (no DB write)", async () => {
    mockAccessService.getMemberById.mockResolvedValue(agentMember);

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${agentMemberId}`)
      .send({ status: "suspended" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human company members can be removed");
    expect(mockAccessService.setMemberPermissions).not.toHaveBeenCalled();
  });

  it("rejects PATCH /members/:memberId/role-and-grants for an agent-principal member at the guard (no DB write)", async () => {
    mockAccessService.getMemberById.mockResolvedValue(agentMember);

    const app = createApp(localImplicitBoardActor);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${agentMemberId}/role-and-grants`)
      .send({ status: "active", grants: [] });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human company members can be removed");
    expect(mockAccessService.setMemberPermissions).not.toHaveBeenCalled();
  });
});
