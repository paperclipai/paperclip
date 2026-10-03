import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  isInstanceAdmin: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  deduplicateAgentName: vi.fn(),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

const pendingJoinRequest = {
  id: "jr-1",
  companyId: "company-1",
  requestType: "agent",
  status: "pending_approval",
  adapterType: "claude_local",
  agentName: "Test Agent",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const approvedJoinRequest = {
  ...pendingJoinRequest,
  id: "jr-2",
  status: "approved",
};

/**
 * Build a mock DB that mimics drizzle's query builder thenable pattern.
 * Drizzle queries are thenable — `.then(cb)` executes and passes rows to cb.
 */
function createDbStub(findResult: Record<string, unknown> | null = pendingJoinRequest) {
  const selectResult = findResult ? [findResult] : [];

  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
          Promise.resolve(cb(selectResult)),
        ),
      }),
    }),
  };

  const deleteChain = {
    where: vi.fn().mockReturnValue({
      then: vi.fn().mockImplementation((cb?: (v: unknown) => unknown) =>
        Promise.resolve(cb ? cb(undefined) : undefined),
      ),
    }),
  };

  return {
    select: vi.fn().mockReturnValue(selectChain),
    delete: vi.fn().mockReturnValue(deleteChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

function createApp(
  actor: Record<string, unknown>,
  db: Record<string, unknown>,
) {
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

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

describe("DELETE /companies/:companyId/join-requests/:requestId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with { deleted: true, id } on success", async () => {
    const db = createDbStub(pendingJoinRequest);
    const app = createApp(boardActor, db);

    const res = await request(app)
      .delete("/api/companies/company-1/join-requests/jr-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: "jr-1" });
  });

  it("logs activity after deletion", async () => {
    const db = createDbStub(pendingJoinRequest);
    const app = createApp(boardActor, db);

    await request(app)
      .delete("/api/companies/company-1/join-requests/jr-1");

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "join.deleted",
        entityType: "join_request",
        entityId: "jr-1",
      }),
    );
  });

  it("returns 404 when join request does not exist", async () => {
    const db = createDbStub(null);
    const app = createApp(boardActor, db);

    const res = await request(app)
      .delete("/api/companies/company-1/join-requests/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 when join request is already approved", async () => {
    const db = createDbStub(approvedJoinRequest);
    const app = createApp(boardActor, db);

    const res = await request(app)
      .delete("/api/companies/company-1/join-requests/jr-2");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already-approved");
  });

  it("returns 403 when agent lacks joins:approve permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    const db = createDbStub(pendingJoinRequest);
    const app = createApp(agentActor, db);

    const res = await request(app)
      .delete("/api/companies/company-1/join-requests/jr-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });

  it("returns 403 when board user lacks joins:approve permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const db = createDbStub(pendingJoinRequest);
    const app = createApp(
      { ...boardActor, source: "session" },
      db,
    );

    const res = await request(app)
      .delete("/api/companies/company-1/join-requests/jr-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });
});
