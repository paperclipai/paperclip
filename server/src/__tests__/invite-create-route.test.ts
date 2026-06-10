import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: vi.fn(),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                brandColor: "#114488",
                logoAssetId: "logo-1",
              }]);
            },
          };
          return query;
        },
      };
    },
  };
}

async function createApp() {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/invites", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    logActivityMock.mockReset();
  });

  it("returns an absolute invite URL using the request base URL", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/pcp_invite_/);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\/invite\/pcp_invite_/);
  });
});

describe("POST /companies/:companyId/invites role-escalation guard (#7786)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    logActivityMock.mockReset();
  });

  async function createAppWithMembershipRole(actorMembershipRole: string) {
    vi.doMock("../services/index.js", () => ({
      accessService: () => ({
        isInstanceAdmin: vi.fn(async () => false),
        canUser: vi.fn(async () => true),
        hasPermission: vi.fn(async () => true),
        getMembership: vi.fn(async () => ({
          status: "active",
          membershipRole: actorMembershipRole,
        })),
      }),
      agentService: () => ({ getById: vi.fn() }),
      boardAuthService: () => ({
        createChallenge: vi.fn(),
        resolveBoardAccess: vi.fn(),
        assertCurrentBoardKey: vi.fn(),
        revokeBoardApiKey: vi.fn(),
      }),
      deduplicateAgentName: vi.fn(),
      logActivity: (...args: unknown[]) => logActivityMock(...args),
      notifyHireApproved: vi.fn(),
    }));
    const [{ accessRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/access.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "api_key",
        userId: "user-actor",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(createDbStub() as any, {
        deploymentMode: "managed",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  it("rejects an admin minting an owner invite with 403", async () => {
    const app = await createAppWithMembershipRole("admin");
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });
    expect(res.status).toBe(403);
  });

  it("rejects an operator minting an admin invite with 403", async () => {
    const app = await createAppWithMembershipRole("operator");
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "admin" });
    expect(res.status).toBe(403);
  });

  it("allows an admin to invite at or below their own role", async () => {
    const app = await createAppWithMembershipRole("admin");
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "admin" });
    expect(res.status).toBe(201);
  });

  it("still allows a default (no humanRole) human invite from an operator", async () => {
    const app = await createAppWithMembershipRole("operator");
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human" });
    expect(res.status).toBe(201);
  });
});
