import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks must be declared before vi.mock() calls.
const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
}));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  instanceSettingsService: () => mockInstanceSettingsService,
}));

// Minimal DB stub: returns empty results by default.
function makeDb(insertResult?: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue(insertResult ? [insertResult] : []);
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const limitMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereForSelect = vi.fn().mockReturnValue({ orderBy: orderByMock, limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereForSelect });
  const select = vi.fn().mockReturnValue({ from: fromMock });
  const update = vi.fn().mockReturnValue({ set });
  return { insert, select, update } as any;
}

let importCounter = 0;

async function createApp(actor: Record<string, unknown>, db?: any) {
  importCounter += 1;
  const modulePath = `../routes/delegate-grants.js?delegate-grants-test-${importCounter}`;
  const middlewarePath = `../middleware/index.js?delegate-grants-test-${importCounter}`;
  const [{ delegateGrantRoutes }, { errorHandler }] = await Promise.all([
    import(modulePath) as Promise<typeof import("../routes/delegate-grants.js")>,
    import(middlewarePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", delegateGrantRoutes(db ?? makeDb()));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/delegate-grants — GC condition: agent must be rejected", () => {
  it("returns 403 when the actor is an agent (GC-agent-cannot-create-grants)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-abc",
      companyId: "company-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/delegate-grants")
      .send({
        delegateAgentId: "11111111-1111-1111-1111-111111111111",
        delegateCompanyId: "22222222-2222-2222-2222-222222222222",
        scopes: ["read"],
      });

    expect(res.status).toBe(403);
  });

  it("returns 403 even when agent is cross-company (GC condition must fire before delegate-grant check)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-abc",
      companyId: "company-other",
    });

    const res = await request(app)
      .post("/api/companies/company-1/delegate-grants")
      .send({
        delegateAgentId: "11111111-1111-1111-1111-111111111111",
        delegateCompanyId: "22222222-2222-2222-2222-222222222222",
        scopes: ["read"],
      });

    expect(res.status).toBe(403);
  });

  it("allows a board actor (local_implicit) to create a grant", async () => {
    const created = {
      id: "grant-id-1",
      hostCompanyId: "company-1",
      delegateAgentId: "11111111-1111-1111-1111-111111111111",
      delegateCompanyId: "22222222-2222-2222-2222-222222222222",
      scopes: ["read"],
      grantedByUserId: "user-board",
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
      cleanupEligibleAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const app = await createApp(
      {
        type: "board",
        userId: "user-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      makeDb(created),
    );

    const res = await request(app)
      .post("/api/companies/company-1/delegate-grants")
      .send({
        delegateAgentId: "11111111-1111-1111-1111-111111111111",
        delegateCompanyId: "22222222-2222-2222-2222-222222222222",
        scopes: ["read"],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("grant-id-1");
  });
});

describe("GET /api/companies/:companyId/delegate-grants", () => {
  it("returns 200 with grants list for authenticated board actor", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/companies/company-1/delegate-grants");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 403 for unauthenticated request", async () => {
    const app = await createApp({ type: "none" });
    const res = await request(app).get("/api/companies/company-1/delegate-grants");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/companies/:companyId/delegate-grants/:grantId", () => {
  it("returns 403 when the actor is an agent", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });

    const res = await request(app).delete(
      "/api/companies/company-1/delegate-grants/grant-id-1",
    );

    expect(res.status).toBe(403);
  });
});
