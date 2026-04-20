import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { memoryRoutes } from "../routes/memory.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";

const mockMemoryService = vi.hoisted(() => ({
  providers: vi.fn(),
  listBindings: vi.fn(),
  listTargets: vi.fn(),
  createBinding: vi.fn(),
  getBindingById: vi.fn(),
  updateBinding: vi.fn(),
  setCompanyDefault: vi.fn(),
  resolveBinding: vi.fn(),
  setAgentOverride: vi.fn(),
  setProjectOverride: vi.fn(),
  query: vi.fn(),
  capture: vi.fn(),
  forget: vi.fn(),
  revoke: vi.fn(),
  correct: vi.fn(),
  review: vi.fn(),
  sweepRetention: vi.fn(),
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  listOperations: vi.fn(),
  listExtractionJobs: vi.fn(),
  startRefreshJob: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
  memoryService: () => mockMemoryService,
  projectService: () => mockProjectService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", memoryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemoryService.getBindingById.mockResolvedValue({
      id: bindingId,
      companyId: companyA,
      key: "primary",
      name: "Primary",
      providerKey: "local_basic",
      config: {},
      enabled: true,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    mockMemoryService.updateBinding.mockResolvedValue({
      id: bindingId,
      companyId: companyA,
      key: "primary",
      name: "Primary",
      providerKey: "local_basic",
      config: {},
      enabled: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    mockProjectService.getById.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      companyId: companyA,
      name: "Project A",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("blocks binding updates for board users outside the binding company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/memory/bindings/${bindingId}`)
      .set("Origin", "http://localhost:3100")
      .send({ enabled: false });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mockMemoryService.getBindingById).toHaveBeenCalledWith(bindingId);
    expect(mockMemoryService.updateBinding).not.toHaveBeenCalled();
  });

  it("allows binding updates when the board user can access the binding company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/memory/bindings/${bindingId}`)
      .set("Origin", "http://localhost:3100")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(mockMemoryService.getBindingById).toHaveBeenCalledWith(bindingId);
    expect(mockMemoryService.updateBinding).toHaveBeenCalledWith(bindingId, { enabled: false });
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("blocks scoped revocation for agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: companyA,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/revoke`)
      .send({
        selector: { recordIds: ["44444444-4444-4444-8444-444444444444"] },
        reason: "Stale memory",
      });

    expect(res.status).toBe(403);
    expect(mockMemoryService.revoke).not.toHaveBeenCalled();
  });

  it("routes board scoped revocation through memory service and activity log", async () => {
    mockMemoryService.revoke.mockResolvedValue({
      operations: [],
      revokedRecordIds: ["44444444-4444-4444-8444-444444444444"],
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/revoke`)
      .set("Origin", "http://localhost:3100")
      .send({
        selector: { issueId: "55555555-5555-4555-8555-555555555555" },
        reason: "Issue memory should be revoked",
      });

    expect(res.status).toBe(200);
    expect(mockMemoryService.revoke).toHaveBeenCalledWith(
      companyA,
      {
        selector: { issueId: "55555555-5555-4555-8555-555555555555" },
        reason: "Issue memory should be revoked",
      },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("routes board correction through memory service", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    mockMemoryService.correct.mockResolvedValue({
      operation: { id: "op-1" },
      originalRecord: { id: recordId },
      correctedRecord: { id: "66666666-6666-4666-8666-666666666666" },
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/records/${recordId}/correct`)
      .set("Origin", "http://localhost:3100")
      .send({ content: "Corrected memory", reason: "User corrected stale fact" });

    expect(res.status).toBe(201);
    expect(mockMemoryService.correct).toHaveBeenCalledWith(
      companyA,
      recordId,
      { content: "Corrected memory", reason: "User corrected stale fact" },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("routes board review decisions through memory service", async () => {
    const recordId = "44444444-4444-4444-8444-444444444444";
    mockMemoryService.review.mockResolvedValue({
      operation: { id: "op-1" },
      record: { id: recordId, reviewState: "accepted" },
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyA}/memory/records/${recordId}/review`)
      .set("Origin", "http://localhost:3100")
      .send({ reviewState: "accepted", note: "Looks correct" });

    expect(res.status).toBe(200);
    expect(mockMemoryService.review).toHaveBeenCalledWith(
      companyA,
      recordId,
      { reviewState: "accepted", note: "Looks correct" },
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });

  it("sets project memory overrides through the owning project company", async () => {
    const projectId = "77777777-7777-4777-8777-777777777777";
    mockMemoryService.setProjectOverride.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      companyId: companyA,
      bindingId,
      targetType: "project",
      targetId: projectId,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .put(`/api/projects/${projectId}/memory-binding`)
      .set("Origin", "http://localhost:3100")
      .send({ bindingId });

    expect(res.status).toBe(200);
    expect(mockProjectService.getById).toHaveBeenCalledWith(projectId);
    expect(mockMemoryService.setProjectOverride).toHaveBeenCalledWith(projectId, bindingId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "memory.project_override_set",
        entityType: "project",
        entityId: projectId,
      }),
    );
  });

  it("blocks project memory overrides outside the board user's companies", async () => {
    const projectId = "77777777-7777-4777-8777-777777777777";
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyB],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .put(`/api/projects/${projectId}/memory-binding`)
      .set("Origin", "http://localhost:3100")
      .send({ bindingId });

    expect(res.status).toBe(403);
    expect(mockMemoryService.setProjectOverride).not.toHaveBeenCalled();
  });

  it("starts memory refresh jobs through the memory service and logs activity", async () => {
    mockMemoryService.startRefreshJob.mockResolvedValue({
      job: {
        id: "99999999-9999-4999-8999-999999999999",
        companyId: companyA,
        key: "memory.refresh",
        jobType: "memory_refresh",
      },
      run: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: companyA,
        jobKey: "memory.refresh",
        jobType: "memory_refresh",
        status: "queued",
      },
      dryRun: false,
      sourceCounts: {
        issue: 1,
        issue_comment: 2,
        issue_document: 1,
        run: 0,
      },
      recordCount: 0,
    });
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyA],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyA}/memory/refresh-jobs`)
      .set("Origin", "http://localhost:3100")
      .send({
        sourceKinds: ["issue", "issue_comment", "issue_document"],
        issueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        dryRun: false,
      });

    expect(res.status).toBe(202);
    expect(mockMemoryService.startRefreshJob).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({
        sourceKinds: ["issue", "issue_comment", "issue_document"],
        issueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        dryRun: false,
      }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: companyA,
        action: "memory.refresh_job_started",
        entityType: "background_job_run",
        entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
  });
});
