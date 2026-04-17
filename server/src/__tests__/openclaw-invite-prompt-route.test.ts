import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  isInstanceAdmin: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    deduplicateAgentName: vi.fn(),
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    defaultsPayload: null,
    expiresAt: new Date("2099-03-07T00:10:00.000Z"),
    invitedByUserId: null,
    tokenHash: "hash",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2099-03-07T00:00:00.000Z"),
    updatedAt: new Date("2099-03-07T00:00:00.000Z"),
  };
  const returning = vi.fn().mockResolvedValue([createdInvite]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const isInvitesTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "tokenHash" in table &&
    "allowedJoinTypes" in table &&
    "inviteType" in table;
  const isCompaniesTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "issuePrefix" in table &&
    "requireBoardApprovalForNewAgents" in table &&
    "feedbackDataSharingEnabled" in table;
  const select = vi.fn((selection?: unknown) => ({
    from(table: unknown) {
      return {
        where: vi.fn().mockImplementation(() => {
          if (isInvitesTable(table)) {
            return Promise.resolve([createdInvite]);
          }
          if (
            (selection && typeof selection === "object" && "name" in selection) ||
            isCompaniesTable(table)
          ) {
            return Promise.resolve([{ name: "Acme AI" }]);
          }
          return Promise.resolve([]);
        }),
      };
    },
  }));
  return {
    insert,
    select,
    __insertValues: values,
  };
}

async function createApp(actor: Record<string, unknown>, db: Record<string, unknown>) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/openclaw/invite-prompt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentService.getById.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects non-CEO agent callers", async () => {
    const db = createDbStub();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      db,
    );

    const res = await request(app)
      .post("/api/companies/company-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
  });

  it("allows CEO agent callers and creates an agent-only invite", async () => {
    const db = createDbStub();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    const app = await createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      db,
    );

    const res = await request(app)
      .post("/api/companies/company-1/openclaw/invite-prompt")
      .send({ agentMessage: "Join and configure OpenClaw gateway." });

    expect([200, 201]).toContain(res.status);
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.onboardingTextPath).toContain("/api/invites/");
    expect((db as any).__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        inviteType: "company_join",
        allowedJoinTypes: "agent",
      }),
    );
  });

  it("includes companyName in invite summary responses", async () => {
    const db = createDbStub();
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.inviteType).toBe("company_join");
    expect(res.body.allowedJoinTypes).toBe("agent");
  });

  it("allows board callers with invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/companies/company-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(201);
    expect((db as any).__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        inviteType: "company_join",
        allowedJoinTypes: "agent",
      }),
    );
  }, 15_000);

  it("rejects board callers without invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(false);
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/companies/company-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });
});
