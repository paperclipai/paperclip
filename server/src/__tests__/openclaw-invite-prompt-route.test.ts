import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: mockLogActivity,
  normalizeRuntimeConfigForCooHeartbeatModel: vi.fn((config: Record<string, unknown>) => config),
  notifyHireApproved: vi.fn(),
  prepareAdapterConfigForPersistence: vi.fn(async ({ adapterConfig }: { adapterConfig: Record<string, unknown> }) => adapterConfig),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  }),
}));

let accessRoutesFactory: typeof import("../routes/access.js").accessRoutes;
let errorHandlerMiddleware: typeof import("../middleware/index.js").errorHandler;

function getDrizzleTableName(table: unknown): string | undefined {
  if (!table || typeof table !== "object") return undefined;
  const drizzleTable = table as Record<PropertyKey, unknown>;
  return (
    (typeof drizzleTable[Symbol.for("drizzle:Name")] === "string"
      ? drizzleTable[Symbol.for("drizzle:Name")]
      : undefined) ??
    (typeof drizzleTable[Symbol.for("drizzle:BaseName")] === "string"
      ? drizzleTable[Symbol.for("drizzle:BaseName")]
      : undefined)
  );
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
  const select = vi.fn(() => ({
    from(table: unknown) {
      const tableName = getDrizzleTableName(table);
      return {
        where: vi.fn().mockImplementation(() => {
          if (tableName === "invites") {
            return Promise.resolve([createdInvite]);
          }
          if (tableName === "companies") {
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
  };
}

function createApp(actor: Record<string, unknown>, db: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutesFactory(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandlerMiddleware);
  return app;
}

describe("POST /companies/:companyId/openclaw/invite-prompt", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ accessRoutes: accessRoutesFactory } = await import("../routes/access.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  }, 30_000);

  beforeEach(() => {
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
    const app = createApp(
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
    const app = createApp(
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
    expect(res.body.allowedJoinTypes).toBe("agent");
    expect(typeof res.body.token).toBe("string");
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.onboardingTextPath).toContain("/api/invites/");
  });

  it("includes companyName in invite summary responses", async () => {
    const db = createDbStub();
    const app = createApp(
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
    expect(res.body.companyId).toBe("company-1");
    expect(res.body.companyName).toBe("Acme AI");
  });

  it("allows board callers with invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp(
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
    expect(res.body.allowedJoinTypes).toBe("agent");
  });

  it("rejects board callers without invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp(
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
