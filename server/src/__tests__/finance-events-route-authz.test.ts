import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "44444444-4444-4444-8444-444444444444";
const agentId = "11111111-1111-4111-8111-111111111111";
const responsibleUserId = "user-responsible-1";

const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  listEvents: vi.fn(),
  byKind: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const emptyService = vi.hoisted(() => () => new Proxy({}, {
  get: () => vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: emptyService,
  agentService: emptyService,
  budgetService: emptyService,
  companyService: emptyService,
  costService: emptyService,
  financeService: () => mockFinanceService,
  heartbeatService: emptyService,
  issueService: emptyService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: vi.fn(async () => []),
}));

type TestActor = Record<string, unknown>;

const boardActor: TestActor = {
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  isInstanceAdmin: false,
};

/**
 * Mirrors what the agent-key middleware attaches in production: the agent's own
 * company plus the responsible user's memberships, which `assertCompanyAccess`
 * also checks on write methods.
 */
const agentActor: TestActor = {
  type: "agent",
  agentId,
  companyId,
  onBehalfOfUserId: responsibleUserId,
  onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }],
};

const foreignAgentActor: TestActor = {
  ...agentActor,
  companyId: otherCompanyId,
};

const viewerResponsibleUserAgentActor: TestActor = {
  ...agentActor,
  onBehalfOfMemberships: [{ companyId, membershipRole: "viewer", status: "active" }],
};

const inactiveResponsibleUserAgentActor: TestActor = {
  ...agentActor,
  onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "archived" }],
};

const validBody = {
  eventKind: "platform_fee",
  biller: "openai",
  amountCents: 1234,
  occurredAt: "2026-08-15T00:00:00.000Z",
};

async function createApp(actor: TestActor) {
  vi.resetModules();
  const [{ errorHandler }, { costRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/costs.js") as Promise<typeof import("../routes/costs.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("POST /api/companies/:companyId/finance-events authorization", () => {
  beforeEach(() => {
    mockFinanceService.createEvent.mockReset();
    mockLogActivity.mockReset();
    mockFinanceService.createEvent.mockImplementation(async (cid: string, input: Record<string, unknown>) => ({
      id: "finance-event-1",
      companyId: cid,
      ...input,
    }));
  });

  it("accepts an agent actor from the same company", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(mockFinanceService.createEvent).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "finance_event.reported",
      }),
    );
  });

  it("still accepts a board actor", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(mockFinanceService.createEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects an agent actor scoped to another company", async () => {
    const app = await createApp(foreignAgentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
    expect(mockFinanceService.createEvent).not.toHaveBeenCalled();
  });

  it("rejects an agent whose responsible user only has viewer access", async () => {
    const app = await createApp(viewerResponsibleUserAgentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Responsible user is not authorized for write access");
    expect(mockFinanceService.createEvent).not.toHaveBeenCalled();
  });

  it("rejects an agent whose responsible user has no active membership", async () => {
    const app = await createApp(inactiveResponsibleUserAgentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Responsible user is unavailable for this company");
    expect(mockFinanceService.createEvent).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated actor", async () => {
    const app = await createApp({ type: "none" });
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance-events`)
      .send(validBody);

    expect(res.status).toBe(401);
    expect(mockFinanceService.createEvent).not.toHaveBeenCalled();
  });
});
