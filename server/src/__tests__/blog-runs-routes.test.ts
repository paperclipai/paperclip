import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { blogRunRoutes } from "../routes/blog-runs.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

const run = {
  id: runId,
  companyId,
  projectId,
  issueId: null,
  topic: "Test topic",
  lane: "publish",
  targetSite: "fluxaivory.com",
  status: "queued",
  currentStep: "research",
  approvalMode: "manual",
  publishMode: "draft",
  wordpressPostId: null,
  publishedUrl: null,
  approvalKeyHash: null,
  publishIdempotencyKey: null,
  contextJson: null,
  failedReason: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-04-03T00:00:00.000Z"),
  updatedAt: new Date("2026-04-03T00:00:00.000Z"),
};

const mockBlogRunService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getDetail: vi.fn(),
  claimNextStep: vi.fn(),
  completeStep: vi.fn(),
  failStep: vi.fn(),
  requestPublishApproval: vi.fn(),
  requestPublishApprovalFromRun: vi.fn(),
  requestResumeReview: vi.fn(),
  markResumable: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBlogRunWorkerService = vi.hoisted(() => ({
  runNext: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  blogRunService: () => mockBlogRunService,
  blogRunWorkerService: () => mockBlogRunWorkerService,
  projectService: () => mockProjectService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", blogRunRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("blog run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId,
      name: "Blog project",
    });
    mockBlogRunService.create.mockResolvedValue(run);
    mockBlogRunService.getById.mockResolvedValue(run);
    mockBlogRunService.getDetail.mockResolvedValue({
      run,
      attempts: [],
      artifacts: [],
      approvals: [],
    });
    mockBlogRunService.claimNextStep.mockResolvedValue({
      run: { ...run, status: "research_running" },
      attempt: { id: attemptId, stepKey: "research", attemptNumber: 1, status: "running" },
    });
    mockBlogRunService.completeStep.mockResolvedValue({
      run: { ...run, status: "research_ready", currentStep: "draft" },
      attempts: [{ id: attemptId, stepKey: "research", status: "completed" }],
      artifacts: [],
      approvals: [],
    });
    mockBlogRunService.failStep.mockResolvedValue({
      run: { ...run, status: "failed", failedReason: "boom" },
      attempts: [{ id: attemptId, stepKey: "research", status: "failed" }],
      artifacts: [],
      approvals: [],
    });
    mockBlogRunService.requestPublishApproval.mockResolvedValue({
      run: { ...run, status: "publish_approved", currentStep: "publish" },
      approval: { id: "approval-1", approvalKeyHash: "approval-hash" },
    });
    mockBlogRunService.requestPublishApprovalFromRun.mockResolvedValue({
      run: { ...run, status: "publish_approved", currentStep: "publish", publishIdempotencyKey: "publish-key" },
      approval: { id: "approval-1", approvalKeyHash: "approval-hash", targetSlug: "test-topic" },
    });
    mockBlogRunWorkerService.runNext.mockResolvedValue({
      run: { ...run, status: "publish_running", currentStep: "publish" },
      attempts: [],
      artifacts: [],
      approvals: [],
    });
    mockBlogRunService.requestResumeReview.mockResolvedValue({
      run: { ...run, status: "review_required", currentStep: "publish" },
      resumeReview: { requestedBy: "operations-lead" },
    });
    mockBlogRunService.markResumable.mockResolvedValue({
      run: { ...run, status: "resumable", currentStep: "publish" },
      resumeEvidence: { operatorReviewedBy: "operations-lead" },
    });
  });

  it("creates a blog run for a project", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/projects/${projectId}/blog-runs`)
      .send({ topic: "New topic", publishMode: "draft" });

    expect(res.status).toBe(201);
    expect(mockBlogRunService.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      projectId,
      topic: "New topic",
      publishMode: "draft",
    }));
  });

  it("lists active blog runs for a company", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    (mockBlogRunService as any).listForCompany = vi.fn().mockResolvedValue([
      { ...run, failedReason: null },
    ]);

    const res = await request(app).get(`/api/companies/${companyId}/blog-runs?limit=3`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((mockBlogRunService as any).listForCompany).toHaveBeenCalledWith(companyId, {
      limit: 3,
      activeOnly: true,
    });
  });

  it("returns a blog run detail", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/blog-runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
  });

  it("claims the next step", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app).post(`/api/blog-runs/${runId}/claim-step`).send({});

    expect(res.status).toBe(200);
    expect(res.body.attempt.id).toBe(attemptId);
    expect(mockBlogRunService.claimNextStep).toHaveBeenCalledWith(runId);
  });

  it("completes a step", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/steps/research/complete`)
      .send({ attemptId, resultJson: { ok: true } });

    expect(res.status).toBe(200);
    expect(mockBlogRunService.completeStep).toHaveBeenCalledWith(runId, "research", expect.objectContaining({
      attemptId,
      resultJson: { ok: true },
    }));
  });

  it("requests publish approval", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/request-publish-approval`)
      .send({
        targetSlug: "test-slug",
        artifactHash: "artifact-hash",
        normalizedDomHash: "dom-hash",
        approvalKeyHash: "approval-hash",
        publishIdempotencyKey: "publish-key",
      });

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("publish_approved");
    expect(mockBlogRunService.requestPublishApproval).toHaveBeenCalledWith(runId, expect.objectContaining({
      targetSlug: "test-slug",
      approvalKeyHash: "approval-hash",
    }));
  });

  it("requests publish approval from run context", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/request-publish-approval-from-run`)
      .send({ approvedByUserId: "operator-user" });

    expect(res.status).toBe(200);
    expect(mockBlogRunService.requestPublishApprovalFromRun).toHaveBeenCalledWith(runId, expect.objectContaining({
      approvedByUserId: "operator-user",
    }));
  });

  it("runs the next blog run step", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/run-next`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockBlogRunWorkerService.runNext).toHaveBeenCalledWith(runId);
  });

  it("requests resume review for a stopped run", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/request-resume-review`)
      .send({
        recoveryAction: "quarantine public article and re-run verify",
        evidenceRefs: ["runs/run-20260404-001/verify/verdict.json"],
        requestedBy: "operations-lead",
      });

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("review_required");
    expect(mockBlogRunService.requestResumeReview).toHaveBeenCalledWith(runId, expect.objectContaining({
      requestedBy: "operations-lead",
    }));
  });

  it("marks a reviewed stopped run as resumable", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/blog-runs/${runId}/mark-resumable`)
      .send({
        specialistAcknowledgedBy: "publish-verify",
        operatorReviewedBy: "operations-lead",
        evidenceRefs: ["runs/run-20260404-001/verify/verdict.json"],
        confirmedRequirements: ["passing public verify verdict on the corrected or quarantined state"],
      });

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("resumable");
    expect(mockBlogRunService.markResumable).toHaveBeenCalledWith(runId, expect.objectContaining({
      operatorReviewedBy: "operations-lead",
    }));
  });
});
