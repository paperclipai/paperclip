import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const serviceMocks = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: serviceMocks.isInstanceAdmin,
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
  const users = [
    {
      id: "user-1",
      name: "Admin User",
      email: "admin@example.com",
      image: null,
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    },
  ];

  const isCompanyMembershipsTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "membershipRole" in table &&
    "principalType" in table &&
    "principalId" in table;
  const isAuthUsersTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "emailVerified" in table &&
    "createdAt" in table &&
    "updatedAt" in table;

  return {
    select() {
      return {
        from(table: unknown) {
          if (isAuthUsersTable(table)) {
            return {
              orderBy() {
                return Promise.resolve(users);
              },
            };
          }
          if (isCompanyMembershipsTable(table)) {
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          }
          throw new Error("Unexpected table");
        },
      };
    },
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api/access",
    accessRoutes(createDbStub() as never, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("access admin routes with scoped board keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.isInstanceAdmin.mockResolvedValue(true);
  });

  it("rejects scoped board API keys even when the underlying user is an instance admin", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      keyId: "key-1",
      companyIds: ["company-a"],
      memberships: [{ companyId: "company-a", membershipRole: "admin", status: "active" }],
      allowedCompanySlugs: ["alpha"],
      credentialCompanySlugs: ["alpha"],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/access/admin/users");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Instance admin required");
  });

  it("allows session instance admins on unrestricted admin routes", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/access/admin/users");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "user-1",
        name: "Admin User",
        email: "admin@example.com",
        image: null,
        isInstanceAdmin: true,
        activeCompanyMembershipCount: 0,
      },
    ]);
  });
});
