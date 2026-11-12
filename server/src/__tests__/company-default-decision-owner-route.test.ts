import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  getMembership: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  companyArtifactsService: () => ({ list: vi.fn() }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  companyService: () => mockCompanyService,
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

function createCompany() {
  const now = new Date("2026-10-29T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    defaultDecisionOwnerUserId: null,
    budgetOwnerUserId: null,
    requireBoardApprovalForNewAgents: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const BOARD = { type: "board", userId: "user-1", source: "local_implicit" };

// PAP-749 task 1d-lite: the default decision owner setting on PATCH /companies/:id.
describe("PATCH /api/companies/:companyId defaultDecisionOwnerUserId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue(createCompany());
  });

  it("sets an active member as the default decision owner and logs the change", async () => {
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockCompanyService.update.mockResolvedValue({ ...createCompany(), defaultDecisionOwnerUserId: "user-2" });
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ defaultDecisionOwnerUserId: "user-2" });

    expect(res.status).toBe(200);
    expect(res.body.defaultDecisionOwnerUserId).toBe("user-2");
    expect(mockAccessService.getMembership).toHaveBeenCalledWith("company-1", "user", "user-2");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.updated",
      entityId: "company-1",
      details: { defaultDecisionOwnerUserId: "user-2" },
    }));
  });

  it("clears the default decision owner without a membership lookup", async () => {
    mockCompanyService.update.mockResolvedValue(createCompany());
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ defaultDecisionOwnerUserId: null });

    expect(res.status).toBe(200);
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
    expect(mockCompanyService.update).toHaveBeenCalledWith(
      "company-1",
      { defaultDecisionOwnerUserId: null },
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.updated",
      details: { defaultDecisionOwnerUserId: null },
    }));
  });

  it.each([
    ["not a member", null],
    ["a suspended member", { status: "suspended" }],
  ])("rejects a user who is %s with 422", async (_label, membership) => {
    mockAccessService.getMembership.mockResolvedValue(membership);
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ defaultDecisionOwnerUserId: "outsider" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("active member");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not let agents change the default decision owner", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", role: "ceo" });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ defaultDecisionOwnerUserId: "user-2" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

// PAP-749 task 1d: the budget owner setting follows the same rules.
describe("PATCH /api/companies/:companyId budgetOwnerUserId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue(createCompany());
  });

  it("sets an active member as the budget owner and logs the change", async () => {
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockCompanyService.update.mockResolvedValue({ ...createCompany(), budgetOwnerUserId: "user-2" });
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ budgetOwnerUserId: "user-2" });

    expect(res.status).toBe(200);
    expect(res.body.budgetOwnerUserId).toBe("user-2");
    expect(mockAccessService.getMembership).toHaveBeenCalledWith("company-1", "user", "user-2");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.updated",
      details: { budgetOwnerUserId: "user-2" },
    }));
  });

  it("clears the budget owner without a membership lookup", async () => {
    mockCompanyService.update.mockResolvedValue(createCompany());
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ budgetOwnerUserId: null });

    expect(res.status).toBe(200);
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { budgetOwnerUserId: null }, expect.anything());
  });

  it("rejects a budget owner who is not an active member with 422", async () => {
    mockAccessService.getMembership.mockResolvedValue({ status: "suspended" });
    const app = await createApp(BOARD);

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ budgetOwnerUserId: "outsider" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Budget owner must be an active member");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("does not let agents change the budget owner", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", role: "ceo" });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ budgetOwnerUserId: "user-2" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
