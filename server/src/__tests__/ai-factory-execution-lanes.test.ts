import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { factoryPolicyContentHash } from "../services/ai-factory-policy.js";
import { HttpError } from "../errors.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const LANE_ID = "22222222-2222-4222-8222-222222222222";
const CTO_ID = "33333333-3333-4333-8333-333333333333";
const ENGINEER_ID = "44444444-4444-4444-8444-444444444444";
const QA_ID = "55555555-5555-4555-8555-555555555555";
const DEVOPS_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_AGENT_ID = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
}));
const mockFactoryExecutionLaneService = vi.hoisted(() => ({ create: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({
  canUserAccessProject: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ list: vi.fn() }));
const mockCompanySkillService = vi.hoisted(() => ({ getAiFactoryPolicy: vi.fn() }));
const mockTreeControlService = vi.hoisted(() => ({ getActivePauseHoldGate: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn(), getRun: vi.fn() }));
const mockIssueVisibilityService = vi.hoisted(() => ({
  canSeeIssue: vi.fn(),
  filterVisibleIssues: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  issueService: () => mockIssueService,
  aiFactoryExecutionLaneService: () => mockFactoryExecutionLaneService,
  agentService: () => mockAgentService,
  companySkillService: () => mockCompanySkillService,
  issueTreeControlService: () => mockTreeControlService,
  heartbeatService: () => mockHeartbeatService,
  issueVisibilityService: () => mockIssueVisibilityService,
  logActivity: mockLogActivity,
}));

const compiledPolicy = {
  version: 1 as const,
  skillKey: "company/acme/ai-factory-policy",
  contentHash: "a".repeat(64),
  policy: {
    version: 1 as const,
    extends: "paperclipai/paperclip/paperclip-ai-factory" as const,
    topology: {
      defaultExecutionLanes: 1,
      maxExecutionLanes: 4,
      allowParallelLanes: false,
      noGrandchildren: true as const,
    },
    roles: { controlOwnerRole: "ceo", laneCoordinatorRole: "cto" },
    stages: [
      { key: "contract", type: "work" as const, role: "cto" },
      { key: "implementation", type: "work" as const, role: "engineer" },
      { key: "independent_qa", type: "verification" as const, role: "qa", independent: true },
      { key: "technical_acceptance", type: "review" as const, role: "cto" },
      { key: "deployment", type: "deployment" as const, role: "devops", optionalWhen: "production" as const },
      { key: "live_qa", type: "verification" as const, role: "qa", independent: true, optionalWhen: "production" as const },
      { key: "final_acceptance", type: "approval" as const, role: "cto", optionalWhen: "production" as const },
    ],
    productionAuthority: {
      mode: "autonomous_unless_hold" as const,
      requireCapabilityPreflightBeforeEscalation: true,
      requireBoardApprovalForIrreversibleActions: true,
    },
    recovery: { attemptMinutes: [2, 10, 30], maxAttemptsPerEvidenceFingerprint: 3 },
  },
  serverInvariants: {
    appendOnlyEvidence: true as const,
    generatedProseIsAdvisory: true as const,
    explicitHoldsStopMutation: true as const,
    noGrandchildren: true as const,
    recoveryDeduplicatedByEvidenceFingerprint: true as const,
  },
  precedence: ["server_invariants", "issue_contract", "company_policy", "agent_skills"] as const,
};
compiledPolicy.contentHash = factoryPolicyContentHash(compiledPolicy.policy);

const parentIssue = {
  id: PARENT_ID,
  identifier: "ELIA-4787",
  companyId: COMPANY_ID,
  parentId: null,
  title: "Ship the workflow",
  assigneeAgentId: CTO_ID,
  priority: "high",
  workMode: "standard",
  visibility: "company",
  executionPolicy: null,
};

const activeAgents = [
  { id: CTO_ID, companyId: COMPANY_ID, name: "CTO", title: "Chief Technology Officer", role: "cto", status: "idle" },
  { id: ENGINEER_ID, companyId: COMPANY_ID, name: "Engineer", title: "Software Engineer", role: "engineer", status: "active" },
  { id: QA_ID, companyId: COMPANY_ID, name: "QA", title: "Quality Assurance", role: "qa", status: "idle" },
  { id: DEVOPS_ID, companyId: COMPANY_ID, name: "DevOps", title: "Platform Engineer", role: "devops", status: "running" },
];

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { aiFactoryExecutionLaneRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/ai-factory-execution-lanes.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", aiFactoryExecutionLaneRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [COMPANY_ID],
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }],
    source: "session",
    isInstanceAdmin: false,
    runId: null,
  };
}

describe("AI Factory execution-lane routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(parentIssue);
    mockAccessService.canUserAccessProject.mockResolvedValue(true);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueVisibilityService.canSeeIssue.mockResolvedValue(true);
    mockIssueVisibilityService.filterVisibleIssues.mockImplementation(async (_principal, issues) => issues);
    mockIssueService.list.mockResolvedValue([]);
    mockAgentService.list.mockResolvedValue(activeAgents);
    mockCompanySkillService.getAiFactoryPolicy.mockResolvedValue(compiledPolicy);
    mockTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue({ kind: "queued", wakeupRequestId: "wake-1" });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: COMPANY_ID,
      agentId: CTO_ID,
      status: "running",
      contextSnapshot: { issueId: PARENT_ID },
    });
    mockIssueService.update.mockResolvedValue({
      ...parentIssue,
      executionPolicy: { factory: { laneKind: "control" } },
    });
    mockIssueService.createChild.mockImplementation(async (parentId: string, data: Record<string, unknown>) => ({
      issue: { id: LANE_ID, parentId, companyId: COMPANY_ID, ...data },
      parentBlockerAdded: Boolean(data.blockParentUntilDone),
    }));
    mockFactoryExecutionLaneService.create.mockImplementation(
      async (parentId: string, input: { child: Record<string, unknown> }) => {
        const created = await mockIssueService.createChild(parentId, input.child);
        return {
          ...created,
          parentPinned: true,
          idempotentReplay: false,
        };
      },
    );
  });

  it("creates a non-production lane with a frozen policy and initialized typed workflow", async () => {
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalledTimes(1);
    expect(mockFactoryExecutionLaneService.create).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({
        companyId: COMPANY_ID,
        parentAuthorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorizeLockedParent: expect.any(Function),
        factoryManagedPolicyPin: expect.objectContaining({
          policyHash: compiledPolicy.contentHash,
        }),
        controlExecutionPolicy: expect.objectContaining({
          factory: expect.objectContaining({
            laneKind: "control",
            topologyMode: "single_execution_lane",
            maxExecutionLanes: 1,
            policySnapshot: compiledPolicy.policy,
          }),
        }),
        child: expect.any(Object),
      }),
    );
    const [, input] = mockIssueService.createChild.mock.calls[0]!;
    const policy = input.executionPolicy as any;
    expect(input).toMatchObject({
      blockParentUntilDone: true,
      factoryManagedCreate: {
        policyHash: compiledPolicy.contentHash,
        controlIssueId: PARENT_ID,
      },
      status: "in_progress",
      assigneeAgentId: CTO_ID,
      priority: "high",
    });
    expect(policy.factory).toMatchObject({
      laneKind: "execution",
      topologyMode: "same_issue_only",
      controlIssueId: PARENT_ID,
      policyKey: compiledPolicy.skillKey,
      policyHash: compiledPolicy.contentHash,
      production: false,
      policySnapshot: compiledPolicy.policy,
    });
    expect(policy.stages.map((stage: any) => stage.key)).toEqual([
      "contract",
      "implementation",
      "independent_qa",
      "technical_acceptance",
    ]);
    expect(policy.stages.find((stage: any) => stage.key === "independent_qa")).toMatchObject({
      independent: true,
      returnToStageKey: "implementation",
      evidenceGates: ["delivery:functional_qa:succeeded"],
      participants: [expect.objectContaining({ agentId: QA_ID })],
    });
    expect(policy.stages.find((stage: any) => stage.key === "implementation").evidenceGates).toEqual([
      "delivery:implementation:succeeded",
      "delivery:ci:succeeded:provider_verified",
    ]);
    expect((input.executionContract as any).extensions.aiFactory).toMatchObject({
      topologyMode: "same_issue_only",
      companyPolicyHash: compiledPolicy.contentHash,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.factory_execution_lane_created", entityId: LANE_ID }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      CTO_ID,
      expect.objectContaining({
        reason: "execution_work_requested",
        contextSnapshot: expect.objectContaining({
          issueId: LANE_ID,
          executionStage: expect.objectContaining({ wakeRole: "worker" }),
        }),
      }),
    );
    expect(response.body.wakeup).toMatchObject({ kind: "queued" });
  });

  it("passes a stable Idempotency-Key fingerprint and returns a replay without duplicate activity", async () => {
    mockFactoryExecutionLaneService.create.mockImplementationOnce(
      async (parentId: string, input: { child: Record<string, unknown> }) => {
        const created = await mockIssueService.createChild(parentId, input.child);
        return {
          ...created,
          parentPinned: false,
          idempotentReplay: true,
        };
      },
    );
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .set("Idempotency-Key", "factory-lane-request-1")
      .send({ roleAgentOverrides: { engineer: ENGINEER_ID } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      lane: { id: LANE_ID },
      parentPinned: false,
      idempotentReplay: true,
    });
    expect(mockFactoryExecutionLaneService.create).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({
        idempotency: {
          key: "factory-lane-request-1",
          requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      CTO_ID,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^factory_execution_lane:/),
      }),
    );
  });

  it("includes production-only deployment, live QA, and final acceptance stages on request", async () => {
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({ production: true });

    expect(response.status).toBe(201);
    const policy = mockIssueService.createChild.mock.calls[0]![1].executionPolicy as any;
    expect(policy.factory.production).toBe(true);
    expect(policy.stages.map((stage: any) => stage.key)).toEqual([
      "contract",
      "implementation",
      "independent_qa",
      "technical_acceptance",
      "deployment",
      "live_qa",
      "final_acceptance",
    ]);
    expect(policy.stages.find((stage: any) => stage.key === "live_qa").returnToStageKey).toBe("deployment");
    expect(policy.stages.find((stage: any) => stage.key === "deployment").evidenceGates).toEqual([
      "delivery:deployment:succeeded:provider_verified",
    ]);
    expect(policy.stages.find((stage: any) => stage.key === "final_acceptance").evidenceGates).toEqual([
      "delivery:deployment:succeeded:provider_verified",
      "delivery:smoke:succeeded",
      "delivery:business_acceptance:accepted:paperclip_verified",
    ]);
  });

  it("does not treat irreversible-action approval as blanket production-lane approval", async () => {
    const app = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: "run-1",
    });
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({ production: true });

    expect(compiledPolicy.policy.productionAuthority).toMatchObject({
      mode: "autonomous_unless_hold",
      requireBoardApprovalForIrreversibleActions: true,
    });
    expect(response.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalledTimes(1);
  });

  it("rejects agent lane creation from a stale or differently scoped run", async () => {
    mockHeartbeatService.getRun.mockResolvedValueOnce({
      id: "run-1",
      companyId: COMPANY_ID,
      agentId: CTO_ID,
      status: "succeeded",
      contextSnapshot: { issueId: PARENT_ID },
    });
    const app = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: "run-1",
    });

    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.details).toMatchObject({
      code: "factory_control_run_required",
      controlIssueId: PARENT_ID,
    });
    expect(mockFactoryExecutionLaneService.create).not.toHaveBeenCalled();
  });

  it("requires the board itself to approve a board-gated production lane", async () => {
    const restrictedPolicy = {
      ...compiledPolicy,
      policy: {
        ...compiledPolicy.policy,
        productionAuthority: {
          ...compiledPolicy.policy.productionAuthority,
          mode: "board_approval_required" as const,
        },
      },
    };
    restrictedPolicy.contentHash = factoryPolicyContentHash(restrictedPolicy.policy);
    mockCompanySkillService.getAiFactoryPolicy.mockResolvedValue(restrictedPolicy);

    const agentApp = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: "run-1",
    });
    const denied = await request(agentApp)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({ production: true });

    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({
      code: "factory_production_board_approval_required",
      controlIssueId: PARENT_ID,
      policyHash: restrictedPolicy.contentHash,
    });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();

    const approved = await request(await createApp(boardActor()))
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({ production: true });
    expect(approved.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalledTimes(1);
  });

  it("lists only typed direct execution lanes for the requested control issue", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: LANE_ID,
        executionPolicy: { factory: { laneKind: "execution", controlIssueId: PARENT_ID } },
      },
      { id: OTHER_AGENT_ID, executionPolicy: null },
    ]);
    const app = await createApp(boardActor());
    const response = await request(app).get(`/api/issues/${PARENT_ID}/execution-lanes`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      controlIssueId: PARENT_ID,
      policyKey: compiledPolicy.skillKey,
      policyHash: compiledPolicy.contentHash,
      lanes: [{ id: LANE_ID }],
    });
  });

  it("does not expose a private execution lane hidden from the requesting principal", async () => {
    const hiddenLane = {
      id: LANE_ID,
      companyId: COMPANY_ID,
      visibility: "private",
      executionPolicy: { factory: { laneKind: "execution", controlIssueId: PARENT_ID } },
    };
    mockIssueService.list.mockResolvedValue([hiddenLane]);
    mockIssueVisibilityService.filterVisibleIssues.mockResolvedValue([]);

    const app = await createApp(boardActor());
    const response = await request(app).get(`/api/issues/${PARENT_ID}/execution-lanes`);

    expect(response.status).toBe(200);
    expect(response.body.lanes).toEqual([]);
    expect(mockIssueVisibilityService.filterVisibleIssues).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user", userId: "board-user" }),
      [hiddenLane],
    );
  });

  it("rejects creation while an active subtree pause hold covers the control issue", async () => {
    mockFactoryExecutionLaneService.create.mockRejectedValueOnce(new HttpError(
      409,
      "AI Factory execution-lane creation is paused by an active issue-tree hold.",
      {
        code: "factory_execution_paused",
        issueId: PARENT_ID,
        holdId: "88888888-8888-4888-8888-888888888888",
        rootIssueId: PARENT_ID,
      },
    ));
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "factory_execution_paused", issueId: PARENT_ID });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects an execution lane as a control parent before reading company policy", async () => {
    mockIssueService.getById.mockResolvedValue({ ...parentIssue, parentId: LANE_ID });
    const app = await createApp(boardActor());
    const response = await request(app).get(`/api/issues/${PARENT_ID}/execution-lanes`);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ code: "factory_lane_parent_required", parentId: LANE_ID });
    expect(mockCompanySkillService.getAiFactoryPolicy).not.toHaveBeenCalled();
  });

  it("denies a board user without access to the control issue project", async () => {
    const projectId = "88888888-8888-4888-8888-888888888888";
    mockIssueService.getById.mockResolvedValue({ ...parentIssue, projectId });
    mockAccessService.canUserAccessProject.mockResolvedValue(false);

    const app = await createApp(boardActor());
    const response = await request(app).get(`/api/issues/${PARENT_ID}/execution-lanes`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("No access to this project");
    expect(mockAccessService.canUserAccessProject).toHaveBeenCalledWith(projectId, "board-user");
    expect(mockCompanySkillService.getAiFactoryPolicy).not.toHaveBeenCalled();
  });

  it("reauthorizes project access against the parent row held by the lane transaction", async () => {
    const projectId = "88888888-8888-4888-8888-888888888888";
    mockAccessService.canUserAccessProject.mockResolvedValue(false);
    mockFactoryExecutionLaneService.create.mockImplementationOnce(
      async (_parentId: string, input: { authorizeLockedParent: (parent: any) => Promise<void> }) => {
        await input.authorizeLockedParent({
          ...parentIssue,
          projectId,
          createdByAgentId: null,
          createdByUserId: null,
          assigneeUserId: null,
        });
        throw new Error("lane creation should not continue after access is revoked");
      },
    );

    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("No access to this project");
    expect(mockAccessService.canUserAccessProject).toHaveBeenCalledWith(projectId, "board-user");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("does not let board authority bypass the tasks:assign grant", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Missing permission: tasks:assign");
    expect(mockAccessService.canUser).toHaveBeenCalledWith(
      COMPANY_ID,
      "board-user",
      "tasks:assign",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("does not let a matching factory-control role bypass the tasks:assign grant", async () => {
    mockIssueService.getById.mockResolvedValue({ ...parentIssue, assigneeAgentId: OTHER_AGENT_ID });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: "run-1",
    });
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Missing permission: tasks:assign");
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      CTO_ID,
      "tasks:assign",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("hides a private control issue from a board user without private access", async () => {
    mockIssueService.getById.mockResolvedValue({ ...parentIssue, visibility: "private" });
    mockIssueVisibilityService.canSeeIssue.mockResolvedValue(false);

    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Control issue not found");
    expect(mockIssueVisibilityService.canSeeIssue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user", userId: "board-user" }),
      expect.objectContaining({ id: PARENT_ID, visibility: "private" }),
    );
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockCompanySkillService.getAiFactoryPolicy).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("hides a private control issue from a matching control-role agent without private access", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...parentIssue,
      assigneeAgentId: OTHER_AGENT_ID,
      visibility: "private",
    });
    mockIssueVisibilityService.canSeeIssue.mockResolvedValue(false);
    const app = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: "run-1",
    });
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Control issue not found");
    expect(mockIssueVisibilityService.canSeeIssue).toHaveBeenCalledWith(
      { kind: "agent", agentId: CTO_ID },
      expect.objectContaining({ id: PARENT_ID, visibility: "private" }),
    );
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
    expect(mockCompanySkillService.getAiFactoryPolicy).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("allows the assigned controlling agent and rejects unrelated worker agents", async () => {
    const assignedApp = await createApp({
      type: "agent",
      agentId: CTO_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: null,
    });
    const allowed = await request(assignedApp).get(`/api/issues/${PARENT_ID}/execution-lanes`);
    expect(allowed.status).toBe(200);

    const unrelatedApp = await createApp({
      type: "agent",
      agentId: OTHER_AGENT_ID,
      companyId: COMPANY_ID,
      source: "api_key",
      runId: null,
    });
    const denied = await request(unrelatedApp).get(`/api/issues/${PARENT_ID}/execution-lanes`);
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ code: "factory_lane_control_forbidden" });
  });

  it("fails closed with a stable error when an independent role has no active agent", async () => {
    mockAgentService.list.mockResolvedValue(activeAgents.filter((agent) => agent.id !== QA_ID));
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ code: "factory_role_unavailable", role: "qa" });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects an override that reuses an implementation participant for independent QA", async () => {
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({
        roleAgentOverrides: {
          engineer: ENGINEER_ID,
          qa: ENGINEER_ID,
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "factory_independence_conflict",
      role: "qa",
      agentId: ENGINEER_ID,
    });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects a stored control snapshot whose content does not match its hash", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...parentIssue,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "single_execution_lane",
          controlIssueId: null,
          coordinator: { type: "agent", agentId: CTO_ID },
          policyKey: compiledPolicy.skillKey,
          policyVersion: "1",
          policyHash: "b".repeat(64),
          maxExecutionLanes: 1,
          policySnapshot: compiledPolicy.policy,
        },
      },
    });
    const app = await createApp(boardActor());
    const response = await request(app).get(`/api/issues/${PARENT_ID}/execution-lanes`);

    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "factory_snapshot_inconsistent",
      rule: "policy_hash",
    });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("enforces the non-parallel company policy before calling child creation", async () => {
    mockIssueService.list.mockResolvedValue([
      { id: LANE_ID, executionPolicy: { factory: { laneKind: "execution", controlIssueId: PARENT_ID } } },
    ]);
    mockFactoryExecutionLaneService.create.mockRejectedValueOnce(new HttpError(
      422,
      "The AI Factory policy allows at most 1 execution lane for this control issue.",
      {
        code: "factory_policy_conflict",
        rule: "max_execution_lanes",
        controlIssueId: PARENT_ID,
        maxExecutionLanes: 1,
      },
    ));
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/issues/${PARENT_ID}/execution-lanes`)
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "factory_policy_conflict",
      rule: "max_execution_lanes",
      maxExecutionLanes: 1,
    });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });
});

describe("selectFactoryAgentForRole", () => {
  it("uses exact roles first and breaks equal matches deterministically", async () => {
    const { selectFactoryAgentForRole } = await import("../routes/ai-factory-execution-lanes.js");
    const selected = selectFactoryAgentForRole({
      role: "engineer",
      agents: [
        { id: ENGINEER_ID, companyId: COMPANY_ID, name: "Zulu", title: null, role: "engineer", status: "idle" },
        { id: OTHER_AGENT_ID, companyId: COMPANY_ID, name: "Alpha", title: null, role: "engineer", status: "active" },
        { id: QA_ID, companyId: COMPANY_ID, name: "Engineer", title: "Engineer", role: "qa", status: "active" },
      ],
    });
    expect(selected.id).toBe(OTHER_AGENT_ID);
  });
});
