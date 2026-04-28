import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/index.js", () => ({
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
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

function createDbStub() {
  const updateMock = vi.fn();
  const invite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: "user-1",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([invite]);
            },
          };
        },
      };
    },
    update(...args: unknown[]) {
      updateMock(...args);
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };

  return { db, updateMock };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [
        {
          companyId: "company-1",
          membershipRole: "owner",
          status: "active",
        },
      ],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /invites/:token/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not consume a human invite when the signed-in user is already a company member", async () => {
    const { db, updateMock } = createDbStub();
    const app = createApp(db);

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You already belong to this company");
    expect(updateMock).not.toHaveBeenCalled();
  });
});
