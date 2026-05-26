import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { weeklyReviewRoutes } from "../routes/weekly-reviews.js";

const mockWeeklyReviewService = vi.hoisted(() => ({
  generateForCompany: vi.fn(),
  refresh: vi.fn(),
  listForCompany: vi.fn(),
  getReviewAccessContext: vi.fn(),
  getReview: vi.fn(),
  getVersionAccessContext: vi.fn(),
  getVersion: vi.fn(),
  getReadiness: vi.fn(),
  getRecommendationActionContext: vi.fn(),
  createRecommendationAction: vi.fn(),
}));

vi.mock("../services/weekly-review/generation.js", () => ({
  weeklyReviewGenerationService: () => mockWeeklyReviewService,
}));

function app(actor: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: true,
      ...actor,
    } as typeof req.actor;
    next();
  });
  app.use("/api", weeklyReviewRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("weekly review routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWeeklyReviewService.generateForCompany.mockResolvedValue({ review: { id: "review-1", companyId: "company-1" } });
    mockWeeklyReviewService.refresh.mockResolvedValue({ review: { id: "review-1", companyId: "company-1" } });
    mockWeeklyReviewService.listForCompany.mockResolvedValue([{ id: "review-1" }]);
    mockWeeklyReviewService.getReviewAccessContext.mockResolvedValue({ id: "review-1", companyId: "company-1" });
    mockWeeklyReviewService.getReview.mockResolvedValue({ review: { id: "review-1", companyId: "company-1" } });
    mockWeeklyReviewService.getVersionAccessContext.mockResolvedValue({ id: "version-1", companyId: "company-1" });
    mockWeeklyReviewService.getVersion.mockResolvedValue({ version: { id: "version-1", companyId: "company-1" } });
    mockWeeklyReviewService.getReadiness.mockResolvedValue({ adapterReadiness: {}, modelAssurance: {} });
    mockWeeklyReviewService.getRecommendationActionContext.mockResolvedValue({
      id: "recommendation-1",
      companyId: "company-1",
    });
    mockWeeklyReviewService.createRecommendationAction.mockResolvedValue({
      action: {
        id: "action-1",
        recommendationId: "recommendation-1",
        companyId: "company-1",
        actionKind: "accept_recommendation",
        status: "completed",
      },
    });
  });

  it("generates a weekly review for a board user with validated date inputs", async () => {
    const res = await request(app())
      .post("/api/companies/company-1/weekly-reviews/generate")
      .send({
        periodStart: "2026-05-11T00:00:00.000Z",
        periodEnd: "2026-05-17T23:59:59.000Z",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ review: { id: "review-1", companyId: "company-1" } });
    expect(mockWeeklyReviewService.generateForCompany).toHaveBeenCalledWith("company-1", {
      periodStart: new Date("2026-05-11T00:00:00.000Z"),
      periodEnd: new Date("2026-05-17T23:59:59.000Z"),
      previousVersionId: undefined,
      actorUserId: "board-user",
    });
  });

  it("refreshes a review through the versioning service", async () => {
    const res = await request(app()).post("/api/weekly-reviews/review-1/refresh").send({});

    expect(res.status).toBe(200);
    expect(mockWeeklyReviewService.refresh).toHaveBeenCalledWith("review-1", {
      actorUserId: "board-user",
    });
  });

  it("exposes read endpoints for company lists, review detail, versions, and readiness metadata", async () => {
    await expect(request(app()).get("/api/companies/company-1/weekly-reviews")).resolves.toMatchObject({
      status: 200,
      body: [{ id: "review-1" }],
    });
    await expect(request(app()).get("/api/weekly-reviews/review-1")).resolves.toMatchObject({
      status: 200,
      body: { review: { id: "review-1", companyId: "company-1" } },
    });
    await expect(request(app()).get("/api/weekly-review-versions/version-1")).resolves.toMatchObject({
      status: 200,
      body: { version: { id: "version-1", companyId: "company-1" } },
    });
    await expect(request(app()).get("/api/weekly-reviews/review-1/readiness")).resolves.toMatchObject({
      status: 200,
      body: { adapterReadiness: {}, modelAssurance: {} },
    });

    expect(mockWeeklyReviewService.listForCompany).toHaveBeenCalledWith("company-1");
    expect(mockWeeklyReviewService.getReviewAccessContext).toHaveBeenCalledWith("review-1");
    expect(mockWeeklyReviewService.getReview).toHaveBeenCalledWith("review-1", { companyId: "company-1" });
    expect(mockWeeklyReviewService.getVersionAccessContext).toHaveBeenCalledWith("version-1");
    expect(mockWeeklyReviewService.getVersion).toHaveBeenCalledWith("version-1", { companyId: "company-1" });
    expect(mockWeeklyReviewService.getReadiness).toHaveBeenCalledWith("review-1");
  });

  it("authorizes unscoped weekly review reads before loading full payloads", async () => {
    mockWeeklyReviewService.getReviewAccessContext.mockResolvedValue({
      id: "review-2",
      companyId: "company-2",
    });

    const res = await request(app({
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    } as Partial<Express.Request["actor"]>)).get("/api/weekly-reviews/review-2");

    expect(res.status).toBe(403);
    expect(mockWeeklyReviewService.getReviewAccessContext).toHaveBeenCalledWith("review-2");
    expect(mockWeeklyReviewService.getReview).not.toHaveBeenCalled();
  });

  it("authorizes refreshes and readiness reads before invoking mutating or detail services", async () => {
    mockWeeklyReviewService.getReviewAccessContext.mockResolvedValue({
      id: "review-2",
      companyId: "company-2",
    });
    const actor = {
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    } as Partial<Express.Request["actor"]>;

    const refresh = await request(app(actor)).post("/api/weekly-reviews/review-2/refresh").send({});
    const readiness = await request(app(actor)).get("/api/weekly-reviews/review-2/readiness");

    expect(refresh.status).toBe(403);
    expect(readiness.status).toBe(403);
    expect(mockWeeklyReviewService.refresh).not.toHaveBeenCalled();
    expect(mockWeeklyReviewService.getReadiness).not.toHaveBeenCalled();
    expect(mockWeeklyReviewService.getReview).not.toHaveBeenCalled();
  });

  it("authorizes unscoped weekly review version reads before loading full payloads", async () => {
    mockWeeklyReviewService.getVersionAccessContext.mockResolvedValue({
      id: "version-2",
      companyId: "company-2",
    });

    const res = await request(app({
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    } as Partial<Express.Request["actor"]>)).get("/api/weekly-review-versions/version-2");

    expect(res.status).toBe(403);
    expect(mockWeeklyReviewService.getVersionAccessContext).toHaveBeenCalledWith("version-2");
    expect(mockWeeklyReviewService.getVersion).not.toHaveBeenCalled();
  });

  it("rejects agent API keys for all weekly review routes", async () => {
    const agentApp = app({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    } as Partial<Express.Request["actor"]>);

    const generate = await request(agentApp)
      .post("/api/companies/company-1/weekly-reviews/generate")
      .send({
        periodStart: "2026-05-11T00:00:00.000Z",
        periodEnd: "2026-05-17T23:59:59.000Z",
      });
    const read = await request(agentApp).get("/api/companies/company-1/weekly-reviews");

    expect(generate.status).toBe(403);
    expect(read.status).toBe(403);
    expect(mockWeeklyReviewService.generateForCompany).not.toHaveBeenCalled();
    expect(mockWeeklyReviewService.listForCompany).not.toHaveBeenCalled();
  });

  it("records a recommendation governance action for a board user with company access", async () => {
    const res = await request(app())
      .post("/api/weekly-review-recommendations/recommendation-1/actions")
      .send({ actionKind: "accept_recommendation", note: "Approved for this week." });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      action: {
        id: "action-1",
        recommendationId: "recommendation-1",
        companyId: "company-1",
        actionKind: "accept_recommendation",
        status: "completed",
      },
    });
    expect(mockWeeklyReviewService.createRecommendationAction).toHaveBeenCalledWith(
      "recommendation-1",
      {
        actionKind: "accept_recommendation",
        note: "Approved for this week.",
      },
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        runId: null,
      },
    );
  });

  it("checks the recommendation company before mutating governance actions", async () => {
    mockWeeklyReviewService.getRecommendationActionContext.mockResolvedValue({
      id: "recommendation-2",
      companyId: "company-2",
    });
    mockWeeklyReviewService.createRecommendationAction.mockResolvedValue({
      action: {
        id: "action-2",
        recommendationId: "recommendation-2",
        companyId: "company-2",
        actionKind: "dismiss_recommendation",
        status: "completed",
      },
    });

    const res = await request(app({
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    } as Partial<Express.Request["actor"]>))
      .post("/api/weekly-review-recommendations/recommendation-2/actions")
      .send({ actionKind: "dismiss_recommendation" });

    expect(res.status).toBe(403);
    expect(mockWeeklyReviewService.createRecommendationAction).not.toHaveBeenCalled();
  });
});
