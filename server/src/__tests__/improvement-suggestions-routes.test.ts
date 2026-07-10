import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  review: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  improvementSuggestionService: () => mockService,
  logActivity: mockLogActivity,
}));

const sourceIssueId = "11111111-1111-4111-8111-111111111111";
const suggestionId = "22222222-2222-4222-8222-222222222222";

const payload = {
  targetLayer: "orchestration_code",
  title: "Expire stale waiting paths",
  summary: "Old interactions can hide liveness incidents.",
  proposedChange: "Require freshness and relevance before treating an interaction as a waiting path.",
  evidence: [{ kind: "issue", ref: sourceIssueId, note: "Stalled despite a pending interaction." }],
  sourceIssueId,
};

function suggestion(originKind: "board_directed" | "agent_detected", status: "accepted" | "pending_review" | "rejected") {
  return {
    id: suggestionId,
    companyId: "company-1",
    originKind,
    status,
    targetLayer: payload.targetLayer,
    title: payload.title,
    summary: payload.summary,
    proposedChange: payload.proposedChange,
    evidence: payload.evidence,
    sourceIssueId,
    sourceRunId: null,
    createdByAgentId: originKind === "agent_detected" ? "agent-1" : null,
    createdByUserId: originKind === "board_directed" ? "board-user" : null,
    reviewedByUserId: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ improvementSuggestionRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/improvement-suggestions.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const runId = req.header("x-paperclip-run-id");
    (req as any).actor = {
      ...actor,
      ...(runId ? { runId } : {}),
    };
    next();
  });
  app.use("/api", improvementSuggestionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("improvement suggestion routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("derives agent-detected provenance from the authenticated actor and audits creation", async () => {
    const created = suggestion("agent_detected", "pending_review");
    mockService.create.mockResolvedValue(created);
    const response = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    }))
      .post("/api/companies/company-1/improvement-suggestions")
      .send(payload);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockService.create).toHaveBeenCalledWith("company-1", payload, {
      type: "agent",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "improvement.suggestion.created",
      entityType: "improvement_suggestion",
      entityId: suggestionId,
      agentId: "agent-1",
      runId: "run-1",
    }));
  });

  it("records board-created entries as directives and rejects agent review attempts", async () => {
    mockService.create.mockResolvedValue(suggestion("board_directed", "accepted"));
    mockLogActivity.mockImplementation(async (_db, input) => {
      if (input.runId) throw new Error("spoofed board run must not reach the activity foreign key");
    });
    const board = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const created = await request(await createApp(board))
      .post("/api/companies/company-1/improvement-suggestions")
      .set("x-paperclip-run-id", "33333333-3333-4333-8333-333333333333")
      .send(payload);
    expect(created.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "improvement.board_directive.recorded",
      runId: null,
    }));
    expect(mockService.create).toHaveBeenCalledWith("company-1", payload, {
      type: "board",
      userId: "board-user",
      localImplicit: true,
    });

    const rejected = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    }))
      .post(`/api/companies/company-1/improvement-suggestions/${suggestionId}/review`)
      .send({ decision: "accept", note: "Agents cannot approve their own suggestions." });
    expect(rejected.status).toBe(403);
    expect(mockService.review).not.toHaveBeenCalled();
  });

  it("lets the board accept a pending suggestion and records the decision", async () => {
    mockService.review.mockResolvedValue(suggestion("agent_detected", "accepted"));
    mockLogActivity.mockImplementation(async (_db, input) => {
      if (input.runId) throw new Error("spoofed board run must not reach the activity foreign key");
    });
    const response = await request(await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post(`/api/companies/company-1/improvement-suggestions/${suggestionId}/review`)
      .set("x-paperclip-run-id", "44444444-4444-4444-8444-444444444444")
      .send({ decision: "accept", note: "Evidence is sufficient." });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockService.review).toHaveBeenCalledWith(
      "company-1",
      suggestionId,
      { decision: "accept", note: "Evidence is sufficient." },
      { userId: "board-user", localImplicit: true },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "improvement.suggestion.accepted",
      entityId: suggestionId,
      runId: null,
    }));
  });

  it("rejects ordinary company members as board governance authority", async () => {
    const operator = {
      type: "board",
      userId: "operator-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }],
      source: "session",
      isInstanceAdmin: false,
    };
    const createResponse = await request(await createApp(operator))
      .post("/api/companies/company-1/improvement-suggestions")
      .send({ ...payload, targetLayer: "company_sop" });
    expect(createResponse.status).toBe(403);
    expect(mockService.create).not.toHaveBeenCalled();

    const reviewResponse = await request(await createApp(operator))
      .post(`/api/companies/company-1/improvement-suggestions/${suggestionId}/review`)
      .send({ decision: "accept", note: "Operators cannot review governance suggestions." });
    expect(reviewResponse.status).toBe(403);
    expect(mockService.review).not.toHaveBeenCalled();
  });

  it("allows company owners for company-level targets but reserves root targets for instance admins", async () => {
    const owner = {
      type: "board",
      userId: "owner-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
      source: "session",
      isInstanceAdmin: false,
    };
    mockService.create.mockResolvedValue({
      ...suggestion("board_directed", "accepted"),
      targetLayer: "company_sop",
    });
    const companyResponse = await request(await createApp(owner))
      .post("/api/companies/company-1/improvement-suggestions")
      .send({ ...payload, targetLayer: "company_sop" });
    expect(companyResponse.status).toBe(201);

    mockService.create.mockClear();
    const rootResponse = await request(await createApp(owner))
      .post("/api/companies/company-1/improvement-suggestions")
      .send(payload);
    expect(rootResponse.status).toBe(403);
    expect(mockService.create).not.toHaveBeenCalled();

    mockService.create.mockResolvedValue(suggestion("board_directed", "accepted"));
    const instanceAdminResponse = await request(await createApp({
      type: "board",
      userId: "instance-admin",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: true,
    }))
      .post("/api/companies/company-1/improvement-suggestions")
      .send(payload);
    expect(instanceAdminResponse.status).toBe(201);
    expect(mockService.create).toHaveBeenCalledWith("company-1", payload, {
      type: "board",
      userId: "instance-admin",
      localImplicit: false,
    });
  });
});
