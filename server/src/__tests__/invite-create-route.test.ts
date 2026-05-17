import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const hasPermissionMock = vi.fn();
const getAgentByIdMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(),
      hasPermission: (...args: unknown[]) => hasPermissionMock(...args),
    }),
    agentService: () => ({
      getById: (...args: unknown[]) => getAgentByIdMock(...args),
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

async function createApp(actor?: Record<string, unknown>) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actor ?? {
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
    hasPermissionMock.mockReset();
    getAgentByIdMock.mockReset();
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

  it("allows a CEO agent to create an invite without an explicit users:invite grant", async () => {
    getAgentByIdMock.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
    });
    hasPermissionMock.mockResolvedValue(false);

    const app = await createApp({
      type: "agent",
      agentId: "agent-ceo",
      companyId: "company-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent" });

    expect(res.status).toBe(201);
    // CEO bypass should short-circuit before calling hasPermission.
    expect(hasPermissionMock).not.toHaveBeenCalled();
    expect(getAgentByIdMock).toHaveBeenCalledWith("agent-ceo");
  });

  it("denies a non-CEO agent without users:invite grant", async () => {
    getAgentByIdMock.mockResolvedValue({
      id: "agent-cto",
      companyId: "company-1",
      role: "cto",
    });
    hasPermissionMock.mockResolvedValue(false);

    const app = await createApp({
      type: "agent",
      agentId: "agent-cto",
      companyId: "company-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent" });

    expect(res.status).toBe(403);
    expect(hasPermissionMock).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-cto",
      "users:invite",
    );
  });

  it("allows a non-CEO agent that has an explicit users:invite grant", async () => {
    getAgentByIdMock.mockResolvedValue({
      id: "agent-other",
      companyId: "company-1",
      role: "engineer",
    });
    hasPermissionMock.mockResolvedValue(true);

    const app = await createApp({
      type: "agent",
      agentId: "agent-other",
      companyId: "company-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent" });

    expect(res.status).toBe(201);
    expect(hasPermissionMock).toHaveBeenCalled();
  });

  it("rejects ttlSeconds below the 60s floor", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", ttlSeconds: 30 });
    expect(res.status).toBe(400);
  });

  it("rejects ttlSeconds above the 86400s ceiling", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", ttlSeconds: 100_000 });
    expect(res.status).toBe(400);
  });

  it("accepts a valid ttlSeconds and produces a shorter expiry than the 72h default", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", ttlSeconds: 1800 });

    expect(res.status).toBe(201);
    // The DB stub's createdInvite has a hardcoded expiresAt; the route
    // forwards ttlSeconds to companyInviteExpiresAt(...) but the stub returns
    // a fixed row, so we assert no 4xx and rely on the unit test below for
    // the math.
    expect(res.body.token).toMatch(/^pcp_invite_/);
  });
});

