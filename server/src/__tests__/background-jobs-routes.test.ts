import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { backgroundJobRoutes } from "../routes/background-jobs.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";

const mockBackgroundJobService = vi.hoisted(() => ({
  createOrUpdateJob: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  createRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  listRunEvents: vi.fn(),
  requestCancelRun: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  backgroundJobService: () => mockBackgroundJobService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", backgroundJobRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("background job routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockBackgroundJobService.createOrUpdateJob.mockResolvedValue({
      id: jobId,
      companyId: companyA,
      key: "memory.refresh",
      jobType: "memory_refresh",
      displayName: "Memory refresh",
      backendKind: "server_worker",
      status: "active",
      config: {},
    });
    mockBackgroundJobService.createRun.mockResolvedValue({
      id: runId,
      companyId: companyA,
      jobId,
      jobKey: "memory.refresh",
      jobType: "memory_refresh",
      trigger: "manual",
      status: "queued",
    });
    mockBackgroundJobService.requestCancelRun.mockResolvedValue({
      id: runId,
      companyId: companyA,
      jobId,
      jobKey: "memory.refresh",
      jobType: "memory_refresh",
      trigger: "manual",
      status: "running",
      cancellationRequestedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
  });

  it("blocks board users outside the company from listing jobs", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyA}/background-jobs`)
      .set("Origin", "http://localhost:3100");

    expect(res.status).toBe(403);
    expect(mockBackgroundJobService.listJobs).not.toHaveBeenCalled();
  });

  it("creates a generic background job definition and logs activity", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/background-jobs`)
      .set("Origin", "http://localhost:3100")
      .send({
        key: "memory.refresh",
        jobType: "memory_refresh",
        displayName: "Memory refresh",
        backendKind: "server_worker",
      });

    expect(res.status).toBe(201);
    expect(mockBackgroundJobService.createOrUpdateJob).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ key: "memory.refresh", jobType: "memory_refresh" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "background_job.upserted",
        entityId: jobId,
      }),
    );
  });

  it("creates a generic background job run", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/background-job-runs`)
      .set("Origin", "http://localhost:3100")
      .send({ jobId, trigger: "manual", totalItems: 3 });

    expect(res.status).toBe(201);
    expect(mockBackgroundJobService.createRun).toHaveBeenCalledWith(
      companyA,
      { jobId, trigger: "manual", totalItems: 3 },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
  });

  it("requests cancellation for a run", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/background-job-runs/${runId}/cancel`)
      .set("Origin", "http://localhost:3100")
      .send({});

    expect(res.status).toBe(200);
    expect(mockBackgroundJobService.requestCancelRun).toHaveBeenCalledWith(companyA, runId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "background_job_run.cancel_requested",
        entityId: runId,
      }),
    );
  });
});
