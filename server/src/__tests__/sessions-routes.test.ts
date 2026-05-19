import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAPERCLIP_SESSION_SCHEMA_VERSION, type PaperclipSessionActor } from "@paperclipai/shared";
import { sessionRoutes } from "../routes/sessions.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const participantAgentId = "11111111-1111-4111-8111-111111111111";
const runId = "44444444-4444-4444-8444-444444444444";

const boardActor: PaperclipSessionActor = {
  actorType: "board",
  actorId: "local-board",
  agentId: null,
  userId: "local-board",
  runId: null,
};

const agentActor: PaperclipSessionActor = {
  actorType: "agent",
  actorId: participantAgentId,
  agentId: participantAgentId,
  runId,
};

const mockSessionService = vi.hoisted(() => ({
  transition: vi.fn(),
  respond: vi.fn(),
  inspect: vi.fn(),
  routeTask: vi.fn(),
  redactReceipt: vi.fn(),
  rollbackDisable: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
  sessionService: () => mockSessionService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sessionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function transitionBody(actor = boardActor) {
  return {
    issueId,
    expectedRevisionId: null,
    expectedState: null,
    transition: "create",
    actor,
    idempotencyKey: "session-create",
    nextState: {
      schemaVersion: PAPERCLIP_SESSION_SCHEMA_VERSION,
      policyKey: "car-leadership-sessions",
      policyVersion: "2026-05-18",
      companyId,
      issueId,
      sessionType: "eod",
      state: "open",
      stateRevision: 0,
      idempotencyKey: "session-create",
      objective: "Review the day and create owner-bound work.",
      source: { source: "test" },
      participants: [{ role: "CRO", agentId: participantAgentId, issueId: null, status: "pending" }],
      receipts: [],
      taskRoutes: [],
      reviews: [],
      eodFindings: [],
      health: [],
      lastTransition: {
        transitionId: "55555555-5555-4555-8555-555555555555",
        transition: "create",
        actor,
        beforeState: null,
        afterState: "open",
        at: "2026-05-18T19:00:00.000Z",
      },
    },
  };
}

function taskRouteBody(actor = boardActor) {
  return {
    issueId,
    expectedRevisionId: "66666666-6666-4666-8666-666666666666",
    sourceFindingId: "CAR-1095",
    intendedOwnerRole: "CRO",
    targetRole: "CRO",
    title: "Investigate CAR-1095",
    description: "Create the next paper-work action for CAR-1095.",
    priority: "high",
    assigneeAgentId: participantAgentId,
    actor,
  };
}

describe("session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(false);
    mockSessionService.transition.mockResolvedValue({
      companyId,
      replayed: false,
      document: { latestRevisionId: "66666666-6666-4666-8666-666666666666" },
      session: { state: "open" },
    });
    mockSessionService.respond.mockResolvedValue({ companyId, session: { state: "reviewing" } });
    mockSessionService.inspect.mockResolvedValue({ companyId, session: { state: "open" } });
    mockSessionService.routeTask.mockResolvedValue({ route: { authorityPath: "service" } });
    mockSessionService.redactReceipt.mockResolvedValue({ companyId });
    mockSessionService.rollbackDisable.mockResolvedValue({ companyId, futureTriggersDisabled: true });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows local board operators to create session transitions", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).post("/api/sessions/transition").send(transitionBody());

    expect(res.status).toBe(202);
    expect(mockSessionService.transition).toHaveBeenCalledWith(expect.objectContaining({ transition: "create" }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "session.transition",
      entityId: issueId,
    }));
  });

  it("requires tasks:assign for non-admin board session transitions", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).post("/api/sessions/transition").send(transitionBody({
      ...boardActor,
      actorId: "board-user",
      userId: "board-user",
    }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockSessionService.transition).not.toHaveBeenCalled();
  });

  it("accepts participant responses only from the authenticated participant run", async () => {
    const app = createApp({
      type: "agent",
      agentId: participantAgentId,
      companyId,
      runId,
    });

    const res = await request(app).post("/api/sessions/respond").send({
      issueId,
      participantAgentId,
      expectedRevisionId: "66666666-6666-4666-8666-666666666666",
      response: { responseId: "resp-1" },
      actor: agentActor,
    });

    expect(res.status).toBe(201);
    expect(mockSessionService.respond).toHaveBeenCalled();
  });

  it("rejects participant responses with a mismatched run id", async () => {
    const app = createApp({
      type: "agent",
      agentId: participantAgentId,
      companyId,
      runId,
    });

    const res = await request(app).post("/api/sessions/respond").send({
      issueId,
      participantAgentId,
      expectedRevisionId: "66666666-6666-4666-8666-666666666666",
      response: { responseId: "resp-1" },
      actor: { ...agentActor, runId: "77777777-7777-4777-8777-777777777777" },
    });

    expect(res.status).toBe(403);
    expect(mockSessionService.respond).not.toHaveBeenCalled();
  });

  it("requires a matching board actor and tasks:assign for task routing", async () => {
    const mismatchedActorApp = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const mismatch = await request(mismatchedActorApp).post("/api/sessions/task-route").send(taskRouteBody());

    expect(mismatch.status).toBe(403);
    expect(mockSessionService.inspect).not.toHaveBeenCalled();
    expect(mockSessionService.routeTask).not.toHaveBeenCalled();

    const limitedBoardApp = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const limited = await request(limitedBoardApp).post("/api/sessions/task-route").send(taskRouteBody({
      ...boardActor,
      actorId: "board-user",
      userId: "board-user",
    }));

    expect(limited.status).toBe(403);
    expect(limited.body.error).toContain("tasks:assign");
    expect(mockSessionService.routeTask).not.toHaveBeenCalled();
  });

  it("requires a matching board actor for receipt redaction", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).post("/api/sessions/receipt-redact").send({
      issueId,
      expectedRevisionId: "66666666-6666-4666-8666-666666666666",
      redaction: {
        auditId: "audit-car-1095",
        managerReceipt: { finding: "CAR-1095", secret: "manager-only" },
        participantReceipt: { finding: "CAR-1095", secret: "[redacted]" },
        redactedFields: ["secret"],
      },
      actor: boardActor,
    });

    expect(res.status).toBe(403);
    expect(mockSessionService.redactReceipt).not.toHaveBeenCalled();
  });

  it("filters manager audit receipts from agent inspect responses", async () => {
    const participantIssueId = "77777777-7777-4777-8777-777777777777";
    const otherParticipantIssueId = "88888888-8888-4888-8888-888888888888";
    const receipts = [
      {
        receiptId: "manager-receipt",
        visibility: "manager_audit",
        issueId: null,
        documentId: "99999999-9999-4999-8999-999999999999",
        redacted: false,
      },
      {
        receiptId: "participant-receipt",
        visibility: "participant_redacted",
        issueId: participantIssueId,
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        redacted: true,
      },
      {
        receiptId: "other-participant-receipt",
        visibility: "participant_redacted",
        issueId: otherParticipantIssueId,
        documentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        redacted: true,
      },
    ];
    mockSessionService.inspect.mockResolvedValue({
      companyId,
      participantIssues: [
        { id: participantIssueId, assigneeAgentId: participantAgentId },
        { id: otherParticipantIssueId, assigneeAgentId: "99999999-1111-4111-8111-111111111111" },
      ],
      session: { state: "reviewing", receipts },
      receipts,
    });
    const app = createApp({
      type: "agent",
      agentId: participantAgentId,
      companyId,
      runId,
    });

    const res = await request(app).post("/api/sessions/inspect").send({
      issueId,
      includeReceipts: true,
      actor: agentActor,
    });

    expect(res.status).toBe(200);
    expect(res.body.receipts).toEqual([receipts[1]]);
    expect(res.body.session.receipts).toEqual([receipts[1]]);
  });
});
