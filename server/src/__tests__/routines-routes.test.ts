import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Loaded via `vi.importActual` (not a static import) so it resolves against
 * the same post-`vi.resetModules()` module registry that `createApp` uses —
 * otherwise `errorHandler`'s `instanceof HttpError` check fails against a
 * `HttpError` built from a different module instance. */
async function loadErrors() {
  return vi.importActual<typeof import("../errors.js")>("../errors.js");
}

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";
const revisionId = "77777777-7777-4777-8777-777777777777";

const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables: [],
  latestRevisionId: revisionId,
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const revision = {
  id: revisionId,
  companyId,
  routineId,
  revisionNumber: 1,
  title: "Daily routine",
  description: null,
  snapshot: {
    version: 1,
    routine: {
      id: routineId,
      companyId,
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "Daily routine",
      description: null,
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    },
    triggers: [],
  },
  changeSummary: "Created routine",
  restoredFromRevisionId: null,
  createdByAgentId: null,
  createdByUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
};
const pausedRoutine = {
  ...routine,
  status: "paused",
};
const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackRoutineCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackRoutineCreated: mockTrackRoutineCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
    routineService: () => mockRoutineService,
  }));
}

async function createApp(actor: Record<string, unknown>, routeOptions: Record<string, unknown> = {}) {
  const [{ errorHandler }, { routineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routineRoutes({} as any, routeOptions as any));
  app.use(errorHandler);
  return app;
}

describe("routine routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockRoutineService.list.mockResolvedValue([routine]);
    mockRoutineService.create.mockResolvedValue(routine);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getTrigger.mockResolvedValue(trigger);
    mockRoutineService.update.mockResolvedValue({ ...routine, assigneeAgentId: otherAgentId });
    mockRoutineService.listRevisions.mockResolvedValue([revision]);
    mockRoutineService.restoreRevision.mockResolvedValue({
      routine,
      revision: { ...revision, revisionNumber: 2, restoredFromRevisionId: revision.id },
      restoredFromRevisionId: revision.id,
      restoredFromRevisionNumber: revision.revisionNumber,
      secretMaterials: [],
    });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("passes project filters to the routine list service", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/routines`)
      .query({ projectId });

    expect(res.status).toBe(200);
    expect(mockRoutineService.list).toHaveBeenCalledWith(companyId, { projectId });
  });

  it("lists routine revisions for a board member in newest-first service order", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(200);
    expect(mockRoutineService.listRevisions).toHaveBeenCalledWith(routineId);
    expect(res.body[0]).toMatchObject({ id: revisionId, revisionNumber: 1 });
  });

  it("blocks routine revision reads across company scope", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["99999999-9999-4999-8999-999999999999"],
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(403);
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });

  it("requires an assigned agent for routine revision history access", async () => {
    const app = await createApp({
      type: "agent",
      agentId: otherAgentId,
      companyId,
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(403);
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });

  it("restores routine revisions with existing routine-management permissions", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "88888888-8888-4888-8888-888888888888",
    });

    const res = await request(app).post(`/api/routines/${routineId}/revisions/${revisionId}/restore`).send({});

    expect(res.status).toBe(200);
    expect(mockRoutineService.restoreRevision).toHaveBeenCalledWith(routineId, revisionId, {
      agentId,
      userId: null,
      runId: "88888888-8888-4888-8888-888888888888",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.revision_restored",
      entityId: routineId,
      runId: "88888888-8888-4888-8888-888888888888",
    }));
  });

  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to retarget a routine assignee", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to reactivate a routine", async () => {
    mockRoutineService.get.mockResolvedValue(pausedRoutine);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.createTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({
        enabled: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to manually run a routine", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.runRoutine).not.toHaveBeenCalled();
  });

  it("passes the board actor through when manually running a routine", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(routineId, {
      source: "manual",
    }, {
      agentId: null,
      userId: "board-user",
    });
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      projectId,
      title: "Daily routine",
      assigneeAgentId: agentId,
    }), {
      agentId: null,
      userId: "board-user",
      runId: null,
    });
    expect(mockTrackRoutineCreated).toHaveBeenCalledWith(expect.anything());
  });

  describe("public webhook fire endpoint", () => {
    const publicId = "abcdef0123456789abcdef01";
    const noActor = { type: "none" };

    it("maps headers, idempotency key, and raw payload through to the service", async () => {
      mockRoutineService.firePublicTrigger.mockResolvedValue({
        id: "run-1",
        source: "webhook",
        status: "issue_created",
      });
      const app = await createApp(noActor);

      const res = await request(app)
        .post(`/api/routine-triggers/public/${publicId}/fire`)
        .set("Authorization", "Bearer super-secret")
        .set("Idempotency-Key", "client-key-1")
        .send({ hello: "world" });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ id: "run-1", status: "issue_created" });
      expect(mockRoutineService.firePublicTrigger).toHaveBeenCalledWith(
        publicId,
        expect.objectContaining({
          authorizationHeader: "Bearer super-secret",
          idempotencyKey: "client-key-1",
          payload: { hello: "world" },
        }),
      );
    });

    it("propagates the service's conflict error (paused routine/project or disabled trigger) as 409", async () => {
      const { conflict } = await loadErrors();
      mockRoutineService.firePublicTrigger.mockRejectedValue(conflict("Routine's project is paused"));
      const app = await createApp(noActor);

      const res = await request(app).post(`/api/routine-triggers/public/${publicId}/fire`).send({});

      expect(res.status).toBe(409);
    });

    it("propagates the service's unauthorized error as 401 without leaking why", async () => {
      const { unauthorized } = await loadErrors();
      mockRoutineService.firePublicTrigger.mockRejectedValue(unauthorized());
      const app = await createApp(noActor);

      const res = await request(app).post(`/api/routine-triggers/public/${publicId}/fire`).send({});

      expect(res.status).toBe(401);
    });

    it("rate-limits repeated fires against the same publicId and sets Retry-After", async () => {
      mockRoutineService.firePublicTrigger.mockResolvedValue({
        id: "run-1",
        source: "webhook",
        status: "issue_created",
      });
      const app = await createApp(noActor, {
        webhookTriggerRateLimiter: {
          consume: () => ({ allowed: false, limit: 30, remaining: 0, retryAfterSeconds: 42 }),
        },
      });

      const res = await request(app).post(`/api/routine-triggers/public/${publicId}/fire`).send({});

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("42");
      expect(mockRoutineService.firePublicTrigger).not.toHaveBeenCalled();
    });

    it("allows requests through when the rate limiter has capacity", async () => {
      mockRoutineService.firePublicTrigger.mockResolvedValue({
        id: "run-1",
        source: "webhook",
        status: "issue_created",
      });
      const consume = vi.fn().mockReturnValue({ allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 0 });
      const app = await createApp(noActor, { webhookTriggerRateLimiter: { consume } });

      const res = await request(app).post(`/api/routine-triggers/public/${publicId}/fire`).send({});

      expect(res.status).toBe(202);
      expect(consume).toHaveBeenCalledWith(publicId, expect.any(String));
      expect(mockRoutineService.firePublicTrigger).toHaveBeenCalled();
    });
  });
});
