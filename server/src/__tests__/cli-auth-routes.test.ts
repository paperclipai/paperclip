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

const mockOperatorAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveOperatorAccess: vi.fn(),
  resolveOperatorActivityCompanyIds: vi.fn(),
  assertCurrentOperatorKey: vi.fn(),
  revokeOperatorApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  operatorAuthService: () => mockOperatorAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  return import("../routes/access.js").then(({ accessRoutes }) =>
    import("../middleware/index.js").then(({ errorHandler }) => {
      app.use(
        "/api",
        accessRoutes({} as any, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          bindHost: "127.0.0.1",
          allowedHostnames: [],
        }),
      );
      app.use(errorHandler);
      return app;
    })
  );
}

describe("cli auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a CLI auth challenge with approval metadata", async () => {
    mockOperatorAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "pcp_cli_auth_secret",
      pendingOperatorToken: "pcp_operator_token",
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "operator",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "pcp_cli_auth_secret",
      operatorApiToken: "pcp_operator_token",
      approvalPath: "/cli-auth/challenge-1?token=pcp_cli_auth_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body.approvalUrl).toContain("/cli-auth/challenge-1?token=pcp_cli_auth_secret");
  });

  it("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    mockOperatorAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "operator",
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

  it("approves a CLI auth challenge for a signed-in operator user", async () => {
    mockOperatorAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-1",
        operatorApiKeyId: "operator-key-1",
        requestedAccess: "operator",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockOperatorAuthService.resolveOperatorAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    mockOperatorAuthService.resolveOperatorActivityCompanyIds.mockResolvedValue(["company-1"]);

    const app = await createApp({
      type: "operator",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      approved: true,
      status: "approved",
      userId: "user-1",
      keyId: "operator-key-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "operator_api_key.created",
      }),
    );
  });

  it("logs approve activity for instance admins without company memberships", async () => {
    mockOperatorAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-2",
        operatorApiKeyId: "operator-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockOperatorAuthService.resolveOperatorActivityCompanyIds.mockResolvedValue(["company-a", "company-b"]);

    const app = await createApp({
      type: "operator",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockOperatorAuthService.resolveOperatorActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-1",
      requestedCompanyId: null,
      operatorApiKeyId: "operator-key-2",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("logs revoke activity with resolved audit company ids", async () => {
    mockOperatorAuthService.assertCurrentOperatorKey.mockResolvedValue({
      id: "operator-key-3",
      userId: "admin-2",
    });
    mockOperatorAuthService.resolveOperatorActivityCompanyIds.mockResolvedValue(["company-z"]);

    const app = await createApp({
      type: "operator",
      userId: "admin-2",
      keyId: "operator-key-3",
      source: "operator_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app).post("/api/cli-auth/revoke-current").send({});

    expect(res.status).toBe(200);
    expect(mockOperatorAuthService.resolveOperatorActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-2",
      operatorApiKeyId: "operator-key-3",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-z",
        action: "operator_api_key.revoked",
      }),
    );
  });
});
