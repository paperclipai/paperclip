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
    (req as any).actor = actor;
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
    const board = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const created = await request(await createApp(board))
      .post("/api/companies/company-1/improvement-suggestions")
      .send(payload);
    expect(created.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "improvement.board_directive.recorded",
    }));

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
    const response = await request(await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post(`/api/companies/company-1/improvement-suggestions/${suggestionId}/review`)
      .send({ decision: "accept", note: "Evidence is sufficient." });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockService.review).toHaveBeenCalledWith(
      "company-1",
      suggestionId,
      { decision: "accept", note: "Evidence is sufficient." },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "improvement.suggestion.accepted",
      entityId: suggestionId,
    }));
  });
});
