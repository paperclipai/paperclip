import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  createServiceAccountBoardKey: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

let appImportCounter = 0;

async function createApp(actor: any, db: any = {} as any) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?cli-auth-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cli-auth-routes-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      memberships: Array.isArray(actor.memberships)
        ? actor.memberships.map((membership: unknown) =>
            typeof membership === "object" && membership !== null
              ? { ...membership }
              : membership,
          )
        : actor.memberships,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe.sequential("cli auth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("creates a CLI auth challenge with approval metadata", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "pcp_cli_auth_secret",
      pendingBoardToken: "pcp_board_token",
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "pcp_cli_auth_secret",
      approvalPath: "/cli-auth/challenge-1?token=pcp_cli_auth_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body.boardApiToken).toBe("pcp_board_token");
    expect(res.body.approvalUrl).toContain("/cli-auth/challenge-1?token=pcp_cli_auth_secret");
  });

  it.sequential("rejects anonymous access to generic skill documents", async () => {
    const indexApp = await createApp({ type: "none", source: "none" });
    const skillApp = await createApp({ type: "none", source: "none" });

    const indexRes = await request(indexApp).get("/api/skills/index");
    const skillRes = await request(skillApp).get("/api/skills/paperclip");

    expect(indexRes.status, JSON.stringify(indexRes.body)).toBe(401);
    expect(skillRes.status, skillRes.text || JSON.stringify(skillRes.body)).toBe(401);
  });

  it.sequential("serves the invite-scoped paperclip skill anonymously for active invites", async () => {
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([invite]),
        })),
      })),
    };

    const app = await createApp({ type: "none", source: "none" }, db);
    const res = await request(app).get("/api/invites/token-123/skills/paperclip");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("# Paperclip Skill");
  });

  it.sequential("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/challenges/challenge-1?token=pcp_cli_auth_secret");

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.canApprove).toBe(false);
  });

  it.sequential("approves a CLI auth challenge for a signed-in board user", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-1",
      "pcp_cli_auth_secret",
      "user-1",
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "board_api_key.created",
      }),
    );
  });

  it.sequential("logs approve activity for instance admins without company memberships", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-2",
        boardApiKeyId: "board-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-a", "company-b"]);

    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-1",
      requestedCompanyId: null,
      boardApiKeyId: "board-key-2",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("logs revoke activity with resolved audit company ids", async () => {
    mockBoardAuthService.assertCurrentBoardKey.mockResolvedValue({
      id: "board-key-3",
      userId: "admin-2",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-z"]);

    const app = await createApp({
      type: "board",
      userId: "admin-2",
      keyId: "board-key-3",
      source: "board_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app).post("/api/cli-auth/revoke-current").send({});

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-2",
      boardApiKeyId: "board-key-3",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-z",
        action: "board_api_key.revoked",
      }),
    );
  });

  it.sequential("rejects service-account token issuance for non-board actors", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check" });
    expect(res.status).toBe(401);
    expect(mockBoardAuthService.createServiceAccountBoardKey).not.toHaveBeenCalled();
  });

  it.sequential("rejects service-account token issuance for non-admin board users", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);
    const app = await createApp({
      type: "board",
      userId: "11111111-1111-1111-1111-111111111111",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check" });
    expect(res.status).toBe(403);
    expect(mockBoardAuthService.createServiceAccountBoardKey).not.toHaveBeenCalled();
  });

  it.sequential("issues a default 30-day service-account token for instance admins", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    const issuedExpiresAt = new Date("2026-06-27T17:00:00.000Z");
    mockBoardAuthService.createServiceAccountBoardKey.mockResolvedValue({
      token: "pcp_board_service_default",
      key: {
        id: "key-1",
        userId: "admin-7",
        name: "ccrotate-health-check",
        expiresAt: issuedExpiresAt,
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-a"]);

    const app = await createApp({
      type: "board",
      userId: "admin-7",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-a"],
    });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check" });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      token: "pcp_board_service_default",
      keyId: "key-1",
      name: "ccrotate-health-check",
      userId: "admin-7",
      expiresAt: issuedExpiresAt.toISOString(),
    });
    expect(mockBoardAuthService.createServiceAccountBoardKey).toHaveBeenCalledWith({
      userId: "admin-7",
      name: "ccrotate-health-check",
      ttlMs: undefined,
      neverExpires: false,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-a",
        action: "board_api_key.service_account_created",
        actorId: "admin-7",
      }),
    );
  });

  it.sequential("issues a never-expiring service-account token when requested", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.createServiceAccountBoardKey.mockResolvedValue({
      token: "pcp_board_service_eternal",
      key: {
        id: "key-2",
        userId: "admin-7",
        name: "ccrotate-health-check",
        expiresAt: null,
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

    const app = await createApp({
      type: "board",
      userId: "admin-7",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check", neverExpires: true });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body.expiresAt).toBeNull();
    expect(mockBoardAuthService.createServiceAccountBoardKey).toHaveBeenCalledWith({
      userId: "admin-7",
      name: "ccrotate-health-check",
      ttlMs: undefined,
      neverExpires: true,
    });
  });

  it.sequential("converts ttlDays to milliseconds when calling the service", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.createServiceAccountBoardKey.mockResolvedValue({
      token: "pcp_board_service_year",
      key: {
        id: "key-3",
        userId: "admin-7",
        name: "ccrotate-health-check",
        expiresAt: new Date("2027-05-28T17:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

    const app = await createApp({
      type: "board",
      userId: "admin-7",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check", ttlDays: 365 });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(mockBoardAuthService.createServiceAccountBoardKey).toHaveBeenCalledWith({
      userId: "admin-7",
      name: "ccrotate-health-check",
      ttlMs: 365 * 24 * 60 * 60 * 1000,
      neverExpires: false,
    });
  });

  it.sequential("rejects ttlDays combined with neverExpires", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "admin-7",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/service-account-tokens")
      .send({ name: "ccrotate-health-check", ttlDays: 30, neverExpires: true });

    expect(res.status).toBe(400);
    expect(mockBoardAuthService.createServiceAccountBoardKey).not.toHaveBeenCalled();
  });

  it.sequential("returns cli auth identity from the authenticated actor snapshot", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-7",
      userName: "User Seven",
      userEmail: "user7@example.com",
      keyId: "board-key-7",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: ["company-7"],
      memberships: [{ companyId: "company-7", membershipRole: "owner", status: "active" }],
    });

    const res = await request(app).get("/api/cli-auth/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: "user-7", name: "User Seven", email: "user7@example.com" },
      userId: "user-7",
      isInstanceAdmin: false,
      companyIds: ["company-7"],
      memberships: [{ companyId: "company-7", membershipRole: "owner", status: "active" }],
      source: "board_key",
      keyId: "board-key-7",
    });
    expect(mockBoardAuthService.resolveBoardAccess).not.toHaveBeenCalled();
  });
});
