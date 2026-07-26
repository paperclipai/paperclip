import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const hasPermissionMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(),
      hasPermission: hasPermissionMock,
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

  const returning = vi.fn().mockResolvedValue([createdInvite]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    insert,
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
    __insertValues: values,
  };
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  source: "local_implicit",
  userId: null,
  companyIds: ["company-1"],
}, db = createDbStub()) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
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

  it.each([
    ["agent-created agent invite", {
      type: "agent",
      source: "agent_key",
      agentId: "ceo-agent",
      companyId: "company-1",
    }, "agent", true],
    ["board-created agent invite", {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    }, "agent", false],
    ["board-created mixed invite", {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    }, "both", false],
  ] as const)("rejects board-only agent grants from a %s before persistence", async (
    _label,
    actor,
    allowedJoinTypes,
    expectsAgentPermissionCheck,
  ) => {
    const db = createDbStub();
    hasPermissionMock.mockResolvedValue(true);
    const app = await createApp(actor, db);

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({
        allowedJoinTypes,
        defaultsPayload: {
          agent: {
            grants: [
              {
                permissionKey: "issues:manage_reports",
                scope: null,
              },
            ],
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(
      "Agent invite defaults cannot grant board-only permissions: issues:manage_reports",
    );
    if (expectsAgentPermissionCheck) {
      expect(hasPermissionMock).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "ceo-agent",
        "users:invite",
      );
    } else {
      expect(hasPermissionMock).not.toHaveBeenCalled();
    }
    expect((db as any).__insertValues).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});
