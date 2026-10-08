import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const canUserMock = vi.fn();
const insertMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../modules/agent-lifecycle/index.js", () => ({
    createAgentLifecycle: () => ({}),
    AgentLifecycleConflict: class extends Error {},
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: (...args: unknown[]) => canUserMock(...args),
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
      insertMock();
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

async function createApp(source: "local_implicit" | "session" = "local_implicit") {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source,
      userId: source === "session" ? "inviter-1" : null,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
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
    canUserMock.mockReset();
    insertMock.mockReset();
    canUserMock.mockImplementation(async (_companyId, _userId, permissionKey) => permissionKey === "users:invite");
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

  it.each(["operator", "viewer"])("allows Operators to invite %s members", async (humanRole) => {
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole });

    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it("allows the default Operator role for mixed human and agent invitations", async () => {
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "both" });

    expect(res.status).toBe(201);
    expect(canUserMock).not.toHaveBeenCalledWith("company-1", "inviter-1", "joins:approve");
    expect(canUserMock).not.toHaveBeenCalledWith("company-1", "inviter-1", "users:manage_permissions");
  });

  it("does not require human membership permissions for agent-only invitations", async () => {
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", humanRole: "owner" });

    expect(res.status).toBe(201);
    expect(canUserMock).not.toHaveBeenCalledWith("company-1", "inviter-1", "joins:approve");
    expect(canUserMock).not.toHaveBeenCalledWith("company-1", "inviter-1", "users:manage_permissions");
  });

  it.each(["admin", "owner"])("prevents Operators from inviting %s members", async (humanRole) => {
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole });

    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("requires member-permission management to invite Owners even when join approval is allowed", async () => {
    canUserMock.mockImplementation(async (_companyId, _userId, permissionKey) =>
      permissionKey === "users:invite" || permissionKey === "joins:approve",
    );
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(403);
    expect(canUserMock).toHaveBeenCalledWith("company-1", "inviter-1", "users:manage_permissions");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("allows Owner invitations when both membership permissions are granted", async () => {
    canUserMock.mockResolvedValue(true);
    const res = await request(await createApp("session"))
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(201);
    expect(canUserMock).toHaveBeenCalledWith("company-1", "inviter-1", "joins:approve");
    expect(canUserMock).toHaveBeenCalledWith("company-1", "inviter-1", "users:manage_permissions");
  });
});
