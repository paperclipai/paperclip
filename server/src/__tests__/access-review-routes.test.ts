import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { accessService } from "../services/access.js";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  listCompanyAccessReview: vi.fn(),
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

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
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
}

function createDbStub(results: unknown[]) {
  const queue = [...results];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = queue.shift() ?? [];
          const promise = Promise.resolve(result);
          return {
            orderBy: vi.fn(() => promise),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          };
        }),
      })),
    })),
  };
}

describe("access review service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("includes instance admins and keeps explicit grants separate from effective access", async () => {
    const db = createDbStub([
      [
        {
          id: "membership-reviewer",
          companyId: "company-1",
          principalType: "user",
          principalId: "reviewer-1",
          status: "active",
          membershipRole: "owner",
          createdAt: new Date("2026-04-15T20:00:00.000Z"),
          updatedAt: new Date("2026-04-15T20:00:00.000Z"),
        },
        {
          id: "membership-member",
          companyId: "company-1",
          principalType: "user",
          principalId: "member-1",
          status: "active",
          membershipRole: "member",
          createdAt: new Date("2026-04-15T20:00:00.000Z"),
          updatedAt: new Date("2026-04-15T20:00:00.000Z"),
        },
      ],
      [{ userId: "admin-1" }],
      [
        { userId: "reviewer-1", permissionKey: "users:manage_permissions" },
        { userId: "grant-only-user", permissionKey: "joins:approve" },
      ],
      [
        { id: "reviewer-1", name: "Casey Reviewer", email: "casey@example.com" },
        { id: "member-1", name: "Bob Member", email: "bob@example.com" },
        { id: "admin-1", name: "Alice Admin", email: "alice@example.com" },
      ],
    ]);

    const review = await accessService(db as any).listCompanyAccessReview("company-1");

    expect(review.companyId).toBe("company-1");
    expect(review.people).toEqual([
      {
        userId: "admin-1",
        name: "Alice Admin",
        email: "alice@example.com",
        membershipRole: null,
        membershipStatus: null,
        effectiveAccess: [{ kind: "instance_admin", label: "Instance admin" }],
        explicitPermissions: [],
      },
      {
        userId: "member-1",
        name: "Bob Member",
        email: "bob@example.com",
        membershipRole: "member",
        membershipStatus: "active",
        effectiveAccess: [
          { kind: "company_membership", label: "Active company member" },
        ],
        explicitPermissions: [],
      },
      {
        userId: "reviewer-1",
        name: "Casey Reviewer",
        email: "casey@example.com",
        membershipRole: "owner",
        membershipStatus: "active",
        effectiveAccess: [
          { kind: "company_membership", label: "Active company owner" },
        ],
        explicitPermissions: ["users:manage_permissions"],
      },
    ]);
  });
});

describe("access review route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
    });
  });

  it("returns the company access review for authorized board users", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.listCompanyAccessReview.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-04-15T20:00:00.000Z",
      people: [
        {
          userId: "admin-1",
          name: "Alice Admin",
          email: "alice@example.com",
          membershipRole: null,
          membershipStatus: null,
          effectiveAccess: [{ kind: "instance_admin", label: "Instance admin" }],
          explicitPermissions: [],
        },
      ],
    });

    const app = createApp({
      type: "board",
      userId: "reviewer-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/access-review");

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(
      "company-1",
      "reviewer-1",
      "users:manage_permissions",
    );
    expect(mockAccessService.listCompanyAccessReview).toHaveBeenCalledWith("company-1");
    expect(res.body.people[0]).toMatchObject({
      name: "Alice Admin",
      effectiveAccess: [{ kind: "instance_admin", label: "Instance admin" }],
    });
  });

  it("returns 403 without review data when the caller lacks manage-permissions", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = createApp({
      type: "board",
      userId: "viewer-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/access-review");

    expect(res.status).toBe(403);
    expect(mockAccessService.listCompanyAccessReview).not.toHaveBeenCalled();
    expect(res.body).toEqual({ error: "Permission denied" });
  });
});
