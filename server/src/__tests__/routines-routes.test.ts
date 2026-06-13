import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";
const revisionId = "77777777-7777-4777-8777-777777777777";
const managerAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const subordinateAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const peerAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
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
    agentService: () => mockAgentService,
    logActivity: mockLogActivity,
    routineService: () => mockRoutineService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
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
  app.use("/api", routineRoutes({} as any));
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
    mockAgentService.getById.mockResolvedValue(null);
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

  describe("manager agent chain-of-command routine access", () => {
    const subordinateRoutine = {
      id: routineId,
      companyId,
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "Subordinate routine",
      description: null,
      assigneeAgentId: subordinateAgentId,
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

    function setupManagerChain() {
      // subordinateAgentId.reportsTo = managerAgentId
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === subordinateAgentId) return { id: subordinateAgentId, reportsTo: managerAgentId };
        if (id === managerAgentId) return { id: managerAgentId, reportsTo: null };
        if (id === peerAgentId) return { id: peerAgentId, reportsTo: null };
        return null;
      });
    }

    it("allows a manager to create a routine for a direct subordinate", async () => {
      setupManagerChain();
      const app = await createApp({ type: "agent", agentId: managerAgentId, companyId });

      const res = await request(app)
        .post(`/api/companies/${companyId}/routines`)
        .send({ projectId, title: "Subordinate daily routine", assigneeAgentId: subordinateAgentId });

      expect(res.status).toBe(201);
      expect(mockRoutineService.create).toHaveBeenCalled();
    });

    it("blocks a non-manager agent from creating a routine for another agent", async () => {
      setupManagerChain();
      const app = await createApp({ type: "agent", agentId: peerAgentId, companyId });

      const res = await request(app)
        .post(`/api/companies/${companyId}/routines`)
        .send({ projectId, title: "Peer routine", assigneeAgentId: subordinateAgentId });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/subordinates/);
      expect(mockRoutineService.create).not.toHaveBeenCalled();
    });

    it("allows a manager to update a subordinate's routine", async () => {
      setupManagerChain();
      mockRoutineService.get.mockResolvedValue(subordinateRoutine);
      mockRoutineService.update.mockResolvedValue({ ...subordinateRoutine, title: "Updated" });
      const app = await createApp({ type: "agent", agentId: managerAgentId, companyId });

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ title: "Updated" });

      expect(res.status).toBe(200);
      expect(mockRoutineService.update).toHaveBeenCalled();
    });

    it("blocks a peer agent from updating another agent's routine", async () => {
      setupManagerChain();
      mockRoutineService.get.mockResolvedValue(subordinateRoutine);
      const app = await createApp({ type: "agent", agentId: peerAgentId, companyId });

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ title: "Hijacked" });

      expect(res.status).toBe(403);
      expect(mockRoutineService.update).not.toHaveBeenCalled();
    });

    it("allows a manager to reassign a subordinate's routine to another subordinate", async () => {
      setupManagerChain();
      mockRoutineService.get.mockResolvedValue(subordinateRoutine);
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === subordinateAgentId) return { id: subordinateAgentId, reportsTo: managerAgentId };
        if (id === otherAgentId) return { id: otherAgentId, reportsTo: managerAgentId };
        if (id === managerAgentId) return { id: managerAgentId, reportsTo: null };
        return null;
      });
      mockRoutineService.update.mockResolvedValue({ ...subordinateRoutine, assigneeAgentId: otherAgentId });
      const app = await createApp({ type: "agent", agentId: managerAgentId, companyId });

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ assigneeAgentId: otherAgentId });

      expect(res.status).toBe(200);
      expect(mockRoutineService.update).toHaveBeenCalled();
    });

    it("blocks a manager from reassigning a subordinate's routine to a non-subordinate", async () => {
      setupManagerChain();
      mockRoutineService.get.mockResolvedValue(subordinateRoutine);
      const app = await createApp({ type: "agent", agentId: managerAgentId, companyId });

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ assigneeAgentId: peerAgentId });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/subordinates/);
      expect(mockRoutineService.update).not.toHaveBeenCalled();
    });

    it("allows a manager to delete a trigger on a subordinate's routine", async () => {
      setupManagerChain();
      mockRoutineService.get.mockResolvedValue(subordinateRoutine);
      mockRoutineService.getTrigger.mockResolvedValue({ ...trigger, routineId });
      mockRoutineService.deleteTrigger.mockResolvedValue({ trigger, revision: null });
      const app = await createApp({ type: "agent", agentId: managerAgentId, companyId });

      const res = await request(app).delete(`/api/routine-triggers/${trigger.id}`);

      expect(res.status).toBe(204);
      expect(mockRoutineService.deleteTrigger).toHaveBeenCalled();
    });
  });
});
