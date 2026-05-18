import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { standupRoutes } from "../routes/standups.js";
import { errorHandler } from "../middleware/index.js";
import { unprocessable } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const policyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const participantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "55555555-5555-4555-8555-555555555555";
const serviceRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const actorRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const jobId = "77777777-7777-4777-8777-777777777777";
const replayJobId = "88888888-8888-4888-8888-888888888888";

const policyPayload = {
  policyKey: "car-daily",
  title: "CAR Daily Standup",
  timezone: "America/Chicago",
  scheduleCron: "30 8 * * *",
  recoveryByLocalTime: "09:00",
  responseDueLocalTime: "10:00",
  escalationDueLocalTime: "10:15",
  participantAgentIds: [agentId],
  responseSchema: { required: ["whatHappened", "why", "nextAction"] },
  genericAnswerDenylist: ["monitor", "will review"],
  nonGreenTriggerRule: { status: "non_green" },
  actionRouting: { missing_response: { actingOwnerAgentId: otherAgentId } },
  disableSettings: { allowDisable: true },
  serviceRunId,
};

const manualFirePayload = {
  policyKey: "car-daily",
  triggerConditionSnapshot: { nonGreen: true },
  assessmentSnapshot: { carStatus: "red", generator: "nonproductive" },
  serviceRunId,
};

const processOutboxPayload = {
  companyId,
  sessionId,
  serviceRunId,
  limit: 5,
  now: "2026-05-16T15:30:00.000Z",
};

const responsePayload = {
  sessionId,
  participantId,
  actorRunId,
  response: {
    whatHappened: "Generator loop is nonproductive.",
    why: "The controller has no accepted productive candidate.",
    nextAction: "Create a CRO-owned recovery action.",
    owner: "CRO",
    dueTime: "2026-05-16T17:00:00.000Z",
    proofTarget: "CAR issue with generator recovery proof",
    blockerOrAuthorityGap: "CRO did not convert failure into action.",
    immediateActionTaken: "Opened owner action and proof target.",
  },
};

const actionPayload = {
  sessionId,
  ownerAgentId: otherAgentId,
  sourceBlockerKey: "generator_nonproductive",
  canonicalKey: "car-daily:generator_nonproductive",
  dueAt: "2026-05-16T17:00:00.000Z",
  proofTarget: "CAR issue with generator recovery proof",
  timingState: "before_next_standup",
  serviceRunId,
};

const policy = {
  id: policyId,
  companyId,
  policyKey: "car-daily",
  standupType: "daily",
};

const inspection = {
  policy,
  session: {
    id: sessionId,
    companyId,
    policyId,
  },
  participants: [
    {
      id: participantId,
      companyId,
      sessionId,
      agentId,
      directiveIssueId: "12121212-1212-4121-8121-121212121212",
    },
  ],
  responses: [],
  actions: [],
  escalations: [],
  outboxJobs: [],
  deadLetters: [],
  standup_forced: true,
  action_taken: false,
  car_still_non_green: true,
  partial_failure: false,
  missing_evidence: [],
};

const outboxJob = {
  id: jobId,
  companyId,
  sessionId,
  participantId,
  actionId: null,
  escalationId: null,
  serviceRunId,
  jobType: "directive_wakeup",
  priority: 10,
  targetKind: "agent",
  targetId: agentId,
  idempotencyKey: "original-job",
  payload: { secret: "do not leak", issueId: "12121212-1212-4121-8121-121212121212" },
  status: "failed",
  attempts: 5,
  maxAttempts: 5,
  nextAttemptAt: new Date("2026-05-16T15:00:00.000Z"),
  lastAttemptAt: new Date("2026-05-16T14:50:00.000Z"),
  deliveredAt: null,
  deadLetteredAt: new Date("2026-05-16T14:55:00.000Z"),
  lastError: "delivery failed",
  replayOfJobId: null,
  createdAt: new Date("2026-05-16T14:00:00.000Z"),
  updatedAt: new Date("2026-05-16T14:55:00.000Z"),
};

const replayJob = {
  ...outboxJob,
  id: replayJobId,
  idempotencyKey: "replay-job",
  payload: { secret: "still do not leak" },
  status: "queued",
  attempts: 0,
  replayOfJobId: jobId,
  createdAt: new Date("2026-05-16T15:01:00.000Z"),
  updatedAt: new Date("2026-05-16T15:01:00.000Z"),
};

const mockStandupService = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  upsertPolicy: vi.fn(),
  disablePolicy: vi.fn(),
  fireStandup: vi.fn(),
  submitResponse: vi.fn(),
  createAction: vi.fn(),
  evaluateSla: vi.fn(),
  inspect: vi.fn(),
  getOutboxJob: vi.fn(),
  replayOutboxJob: vi.fn(),
  processOutbox: vi.fn(),
  deliverIssueAssignment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  standupService: () => mockStandupService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", standupRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("standup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(false);
    mockStandupService.getPolicy.mockResolvedValue(policy);
    mockStandupService.upsertPolicy.mockResolvedValue(policy);
    mockStandupService.disablePolicy.mockResolvedValue({ ...policy, status: "disabled" });
    mockStandupService.fireStandup.mockResolvedValue(inspection);
    mockStandupService.submitResponse.mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999", valid: true });
    mockStandupService.createAction.mockResolvedValue({ id: "abababab-abab-4aba-8aba-abababababab" });
    mockStandupService.evaluateSla.mockResolvedValue({ ...inspection, escalations: [{ id: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", companyId }] });
    mockStandupService.inspect.mockResolvedValue(inspection);
    mockStandupService.getOutboxJob.mockResolvedValue(outboxJob);
    mockStandupService.replayOutboxJob.mockResolvedValue(replayJob);
    mockStandupService.processOutbox.mockResolvedValue([
      { ...outboxJob, status: "succeeded", deliveredAt: new Date("2026-05-16T15:30:00.000Z") },
    ]);
  });

  it("allows server-local proof mode to upsert a policy with service-run provenance", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/standup-policies`)
      .send(policyPayload);

    expect(res.status).toBe(201);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockStandupService.upsertPolicy).toHaveBeenCalledWith(companyId, expect.objectContaining({
      policyKey: "car-daily",
      serviceRunId,
    }), {
      userId: "local-board",
    });
  });

  it("requires tasks:assign for a non-admin board policy write", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/standup-policies`)
      .send(policyPayload);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockStandupService.upsertPolicy).not.toHaveBeenCalled();
  });

  it("allows a board operator with tasks:assign to fire a manual standup", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/standups/fire`)
      .send(manualFirePayload);

    expect(res.status).toBe(202);
    expect(mockStandupService.fireStandup).toHaveBeenCalledWith(companyId, expect.objectContaining({
      policyKey: "car-daily",
      serviceRunId,
      triggerSource: "api",
    }));
  });

  it("rejects server-local writes without a service-run id before the service is called", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/standups/fire`)
      .send({
        policyKey: "car-daily",
        triggerConditionSnapshot: { nonGreen: true },
        assessmentSnapshot: { carStatus: "red" },
      });

    expect(res.status).toBe(400);
    expect(mockStandupService.fireStandup).not.toHaveBeenCalled();
  });

  it("surfaces nonexistent service-run rejection from the single-writer service", async () => {
    mockStandupService.upsertPolicy.mockRejectedValueOnce(unprocessable("Service run does not exist"));
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/standup-policies`)
      .send(policyPayload);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Service run does not exist");
  });

  it("accepts participant responses only from the matching authenticated agent run", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      runId: actorRunId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post("/api/standups/responses")
      .send(responsePayload);

    expect(res.status).toBe(201);
    expect(mockStandupService.submitResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      participantId,
      actorRunId,
    }), { agentId });
  });

  it("rejects participant responses from board actors", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/responses")
      .send(responsePayload);

    expect(res.status).toBe(401);
    expect(mockStandupService.submitResponse).not.toHaveBeenCalled();
  });

  it("rejects participant responses when the authenticated run id is missing", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/standups/responses")
      .send(responsePayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("run id");
    expect(mockStandupService.submitResponse).not.toHaveBeenCalled();
  });

  it("rejects participant responses when the authenticated run id does not match actorRunId", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      runId: serviceRunId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post("/api/standups/responses")
      .send(responsePayload);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("run id");
    expect(mockStandupService.submitResponse).not.toHaveBeenCalled();
  });

  it("rejects guest company-scoped inspect requests", async () => {
    const app = createApp({ type: "none", source: "none" });

    const res = await request(app)
      .post("/api/standups/inspect")
      .send({
        companyId,
        policyKey: "car-daily",
        localDate: "2026-05-16",
      });

    expect(res.status).toBe(401);
    expect(mockStandupService.inspect).not.toHaveBeenCalled();
  });

  it("rejects session inspect when the returned session belongs to another company", async () => {
    mockStandupService.inspect.mockResolvedValueOnce({
      ...inspection,
      session: { ...inspection.session, companyId: otherCompanyId },
      policy: { ...inspection.policy, companyId: otherCompanyId },
      participants: [],
    });
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      runId: actorRunId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post("/api/standups/inspect")
      .send({ sessionId });

    expect(res.status).toBe(403);
  });

  it("requires standup operator permission before creating action routes derived from session inspect", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/actions")
      .send(actionPayload);

    expect(res.status).toBe(403);
    expect(mockStandupService.inspect).toHaveBeenCalledWith({ sessionId });
    expect(mockStandupService.createAction).not.toHaveBeenCalled();
  });

  it("allows standup operator permission before evaluating SLA from session inspect", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/sla/evaluate")
      .send({ sessionId, serviceRunId });

    expect(res.status).toBe(200);
    expect(mockStandupService.inspect).toHaveBeenCalledWith({ sessionId });
    expect(mockStandupService.evaluateSla).toHaveBeenCalledWith(expect.objectContaining({ sessionId, serviceRunId }));
  });

  it("replays one standup outbox job for an authorized operator and redacts payload", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/outbox/replay")
      .send({
        jobId,
        idempotencyKey: "replay-job",
        serviceRunId,
      });

    expect(res.status).toBe(201);
    expect(mockStandupService.getOutboxJob).toHaveBeenCalledWith(jobId);
    expect(mockStandupService.replayOutboxJob).toHaveBeenCalledWith(expect.objectContaining({ jobId, idempotencyKey: "replay-job" }));
    expect(res.body.id).toBe(replayJobId);
    expect(res.body.payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("do not leak");
  });

  it("denies replay before calling the replay mutation when board permission is missing", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/outbox/replay")
      .send({
        jobId,
        idempotencyKey: "replay-job",
        serviceRunId,
      });

    expect(res.status).toBe(403);
    expect(mockStandupService.getOutboxJob).toHaveBeenCalledWith(jobId);
    expect(mockStandupService.replayOutboxJob).not.toHaveBeenCalled();
  });

  it("processes standup outbox jobs for an authorized operator and redacts payload", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/outbox/process")
      .send(processOutboxPayload);

    expect(res.status).toBe(200);
    expect(mockStandupService.inspect).toHaveBeenCalledWith({ sessionId });
    expect(mockStandupService.processOutbox).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      sessionId,
      serviceRunId,
      limit: 5,
      now: expect.any(Date),
      deliver: expect.any(Function),
    }));
    expect(res.body.processedCount).toBe(1);
    expect(res.body.processed[0].payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("do not leak");
  });

  it("denies outbox processing before delivery when board permission is missing", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post("/api/standups/outbox/process")
      .send(processOutboxPayload);

    expect(res.status).toBe(403);
    expect(mockStandupService.processOutbox).not.toHaveBeenCalled();
  });
});
