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

async function createApp(actor: any, db: any = {} as any) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
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

describe("cli auth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it("creates a CLI auth challenge with approval metadata", async () => {
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

    expect(res.status).toBe(201);
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

  it("rejects anonymous access to generic skill documents", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const [indexRes, skillRes] = await Promise.all([
      request(app).get("/api/skills/index"),
      request(app).get("/api/skills/paperclip"),
    ]);

    expect(indexRes.status).toBe(401);
    expect(skillRes.status).toBe(401);
  });

  it("serves the invite-scoped paperclip skill anonymously for active invites", async () => {
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

  it("marks challenge status as requiring sign-in for anonymous viewers", async () => {
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

  it("approves a CLI auth challenge for a signed-in board user", async () => {
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

  it("logs approve activity for instance admins without company memberships", async () => {
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

  it("logs revoke activity with resolved audit company ids", async () => {
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
});
