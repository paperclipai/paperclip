import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const canUser = vi.hoisted(() => vi.fn());
const hasPermission = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser,
    hasPermission,
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
  const activeMemberships = [
    { principalId: "user-2", status: "active" as const },
    { principalId: "user-1", status: "active" as const },
  ];
  const users = [
    { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
    { id: "user-2", name: null, email: "alex@example.com", image: null },
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
          if (isCompanyMembershipsTable(table)) {
            const query = {
              where() {
                return query;
              },
              orderBy() {
                return Promise.resolve(activeMemberships);
              },
            };
            return query;
          }
          if (isAuthUsersTable(table)) {
            return {
              where() {
                return Promise.resolve(users);
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
    "/api",
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

describe("GET /companies/:companyId/user-directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canUser.mockResolvedValue(false);
    hasPermission.mockResolvedValue(false);
  });

  it("returns active human users for operators without manage-permissions access", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    });

    const res = await request(app).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: null, email: "alex@example.com", image: null },
        },
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
        },
      ],
    });
  });

  it("returns join approval access without loading join requests", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    });

    const denied = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual({ canApproveJoins: false });

    canUser.mockResolvedValue(true);
    const granted = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ canApproveJoins: true });
    expect(canUser).toHaveBeenCalledWith("company-1", "user-1", "joins:approve");
  });

  it("checks a cloud tenant admin against the same permission as the join list", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [],
    });

    const denied = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual({ canApproveJoins: false });
    expect(canUser).toHaveBeenCalledWith("company-1", "user-1", "joins:approve");

    canUser.mockResolvedValue(true);
    const granted = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ canApproveJoins: true });
  });

  it("checks an agent join approval grant", async () => {
    const app = createApp({ type: "agent", companyId: "company-1", agentId: "agent-1" });

    const denied = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(denied.body).toEqual({ canApproveJoins: false });

    hasPermission.mockResolvedValue(true);
    const granted = await request(app).get("/api/companies/company-1/join-requests/access");
    expect(granted.body).toEqual({ canApproveJoins: true });
    expect(hasPermission).toHaveBeenCalledWith("company-1", "agent", "agent-1", "joins:approve");
  });
});
