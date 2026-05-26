import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

const ceoAgent = { id: "agent-ceo", companyId: "company-1", role: "ceo", status: "idle" };
const nonCeoAgent = { id: "agent-other", companyId: "company-1", role: "engineer", status: "idle" };
const otherCompanyAgent = { id: "agent-x", companyId: "company-2", role: "ceo", status: "idle" };

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => {
      if (id === ceoAgent.id) return ceoAgent;
      if (id === nonCeoAgent.id) return nonCeoAgent;
      if (id === otherCompanyAgent.id) return otherCompanyAgent;
      return null;
    }),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

interface ActorSetup {
  type: "board" | "agent";
  agentId?: string;
  companyId?: string;
}

function makeApp(actor: ActorSetup, db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: actor.type,
      agentId: actor.agentId ?? null,
      companyId: actor.companyId ?? null,
      userId: actor.type === "board" ? "board-user-1" : null,
      source: actor.type === "board" ? "board_user" : "agent_key",
      isInstanceAdmin: actor.type === "board",
      companyIds: actor.type === "board" ? ["company-1", "company-2"] : undefined,
    };
    next();
  });
  app.use("/api/companies", companyRoutes(db as never));
  app.use(errorHandler);
  return app;
}

function makeDbStub(initialRecurringCosts: unknown[] = []) {
  let stored = [...initialRecurringCosts];

  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      then: vi.fn(async (resolve: (value: unknown) => unknown) =>
        resolve([{ recurringCosts: stored }]),
      ),
    };
    return chain;
  });

  const update = vi.fn(() => {
    const chain = {
      set: vi.fn((patch: { recurringCosts?: unknown[] }) => {
        if (Array.isArray(patch.recurringCosts)) {
          stored = [...patch.recurringCosts];
        }
        return chain;
      }),
      where: vi.fn(() => chain),
      returning: vi.fn(() => chain),
      then: vi.fn(async (resolve: (value: unknown) => unknown) =>
        resolve([{ recurringCosts: stored }]),
      ),
    };
    return chain;
  });

  return { db: { select, update }, getStored: () => stored };
}

describe("GET /api/companies/:companyId/recurring-costs", () => {
  it("returns empty array by default for a board user", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "board" }, db);

    const res = await request(app).get("/api/companies/company-1/recurring-costs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recurringCosts: [] });
  });

  it("allows the CEO agent of the company", async () => {
    const seeded = [
      {
        biller: "anthropic",
        provider: "anthropic",
        model: "subscription",
        monthlyCents: 10000,
        startedOn: "2026-01-01",
        endedOn: null,
      },
    ];
    const { db } = makeDbStub(seeded);
    const app = makeApp({ type: "agent", agentId: "agent-ceo", companyId: "company-1" }, db);

    const res = await request(app).get("/api/companies/company-1/recurring-costs");

    expect(res.status).toBe(200);
    expect(res.body.recurringCosts).toHaveLength(1);
    expect(res.body.recurringCosts[0].biller).toBe("anthropic");
  });

  it("forbids a non-CEO agent of the company", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "agent", agentId: "agent-other", companyId: "company-1" }, db);

    const res = await request(app).get("/api/companies/company-1/recurring-costs");

    expect(res.status).toBe(403);
  });

  it("forbids a CEO agent of a different company", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "agent", agentId: "agent-x", companyId: "company-2" }, db);

    const res = await request(app).get("/api/companies/company-1/recurring-costs");

    expect(res.status).toBe(403);
  });
});

describe("PUT /api/companies/:companyId/recurring-costs", () => {
  const validBody = [
    {
      biller: "anthropic",
      provider: "anthropic",
      model: "subscription",
      monthlyCents: 10000,
      startedOn: "2026-05-01",
      endedOn: null,
    },
  ];

  it("board user can replace the recurring_costs array", async () => {
    const { db, getStored } = makeDbStub();
    const app = makeApp({ type: "board" }, db);

    const res = await request(app)
      .put("/api/companies/company-1/recurring-costs")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.recurringCosts).toHaveLength(1);
    expect(getStored()).toEqual(validBody);
  });

  it("CEO agent of the company can replace", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "agent", agentId: "agent-ceo", companyId: "company-1" }, db);

    const res = await request(app)
      .put("/api/companies/company-1/recurring-costs")
      .send(validBody);

    expect(res.status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "board" }, db);

    const res = await request(app)
      .put("/api/companies/company-1/recurring-costs")
      .send([{ biller: "x", monthlyCents: -1 }]);

    expect(res.status).toBe(400);
  });

  it("rejects when endedOn is before startedOn", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "board" }, db);

    const res = await request(app)
      .put("/api/companies/company-1/recurring-costs")
      .send([
        {
          biller: "x",
          provider: "x",
          model: "y",
          monthlyCents: 100,
          startedOn: "2026-02-01",
          endedOn: "2026-01-01",
        },
      ]);

    expect(res.status).toBe(400);
  });

  it("forbids a non-CEO agent", async () => {
    const { db } = makeDbStub();
    const app = makeApp({ type: "agent", agentId: "agent-other", companyId: "company-1" }, db);

    const res = await request(app)
      .put("/api/companies/company-1/recurring-costs")
      .send(validBody);

    expect(res.status).toBe(403);
  });
});
