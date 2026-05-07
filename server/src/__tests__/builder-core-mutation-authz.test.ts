import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCoreMutationTools } from "../services/builder/tools/core-mutation.js";
import { isMutationTool } from "../services/builder/tools/mutation-tool.js";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockRoutineGet = vi.hoisted(() => vi.fn());
const mockRunRoutine = vi.hoisted(() => vi.fn());
const mockRoutineGetTrigger = vi.hoisted(() => vi.fn());
const mockRoutineCreateTrigger = vi.hoisted(() => vi.fn());
const mockRoutineRotateTriggerSecret = vi.hoisted(() => vi.fn());
const mockProjectGetById = vi.hoisted(() => vi.fn());
const mockProjectCreate = vi.hoisted(() => vi.fn());
const mockProjectUpdate = vi.hoisted(() => vi.fn());
const mockAgentGetById = vi.hoisted(() => vi.fn());
const mockApprovalApprove = vi.hoisted(() => vi.fn());
const mockApprovalGetById = vi.hoisted(() => vi.fn());
const mockApprovalReject = vi.hoisted(() => vi.fn());
const mockBuilderProposalGetByApprovalId = vi.hoisted(() => vi.fn());
const mockGoalGetById = vi.hoisted(() => vi.fn());
const mockInviteCreate = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    getById: mockAgentGetById,
  }),
  approvalService: () => ({
    approve: mockApprovalApprove,
    getById: mockApprovalGetById,
    reject: mockApprovalReject,
  }),
  goalService: () => ({
    getById: mockGoalGetById,
  }),
  inviteService: () => ({
    create: mockInviteCreate,
  }),
  issueService: () => ({}),
  projectService: () => ({
    getById: mockProjectGetById,
    create: mockProjectCreate,
    update: mockProjectUpdate,
  }),
  routineService: () => ({
    createTrigger: mockRoutineCreateTrigger,
    get: mockRoutineGet,
    getTrigger: mockRoutineGetTrigger,
    rotateTriggerSecret: mockRoutineRotateTriggerSecret,
    runRoutine: mockRunRoutine,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

vi.mock("../services/builder/proposal-store.js", () => ({
  builderProposalStore: () => ({
    getByApprovalId: mockBuilderProposalGetByApprovalId,
  }),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

function getTool(name: string) {
  const tool = buildCoreMutationTools().find((candidate) => candidate.name === name);
  expect(tool, `${name} should exist`).toBeTruthy();
  return tool!;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("builder core mutation auth guards", () => {
  it("rejects run_routine when projectId belongs to another company", async () => {
    mockRoutineGet.mockResolvedValue({
      id: "routine-1",
      companyId,
    });
    mockRoutineGetTrigger.mockResolvedValue(null);
    mockProjectGetById.mockResolvedValue({
      id: "project-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("run_routine");
    await expect(
      tool.run(
        {
          routineId: "11111111-1111-4111-8111-111111111112",
          projectId: "11111111-1111-4111-8111-111111111113",
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).rejects.toThrow("Project not found");

    expect(mockRunRoutine).not.toHaveBeenCalled();
  });

  it("rejects run_routine when assigneeAgentId belongs to another company", async () => {
    mockRoutineGet.mockResolvedValue({
      id: "routine-1",
      companyId,
    });
    mockRoutineGetTrigger.mockResolvedValue(null);
    mockProjectGetById.mockResolvedValue({
      id: "project-1",
      companyId,
    });
    mockAgentGetById.mockResolvedValue({
      id: "agent-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("run_routine");
    await expect(
      tool.run(
        {
          routineId: "11111111-1111-4111-8111-111111111114",
          projectId: "11111111-1111-4111-8111-111111111115",
          assigneeAgentId: "11111111-1111-4111-8111-111111111116",
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).rejects.toThrow("Assignee agent not found");

    expect(mockRunRoutine).not.toHaveBeenCalled();
  });

  it("returns tool error when triggerId belongs to another company", async () => {
    mockRoutineGet.mockResolvedValue({
      id: "routine-1",
      companyId,
    });
    mockRoutineGetTrigger.mockResolvedValue({
      id: "trigger-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("run_routine");
    await expect(
      tool.run(
        {
          routineId: "11111111-1111-4111-8111-111111111120",
          triggerId: "11111111-1111-4111-8111-111111111121",
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Routine trigger not found",
    });

    expect(mockRunRoutine).not.toHaveBeenCalled();
  });

  it("returns tool error for create_project when deprecated goalId belongs to another company", async () => {
    mockGoalGetById.mockResolvedValue({
      id: "goal-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("create_project");

    await expect(
      tool.run(
        {
          name: "Project X",
          goalId: "11111111-1111-4111-8111-111111111117",
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Goal not found",
    });

    expect(mockProjectCreate).not.toHaveBeenCalled();
  });

  it("returns tool error for update_project when deprecated goalId belongs to another company", async () => {
    mockGoalGetById.mockResolvedValue({
      id: "goal-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("update_project");

    await expect(
      tool.run(
        {
          projectId: "11111111-1111-4111-8111-111111111118",
          goalId: "11111111-1111-4111-8111-111111111119",
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Goal not found",
    });

    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it("rejects update_agent budget changes and directs callers to set_budget", async () => {
    const tool = getTool("update_agent");

    await expect(
      tool.run(
        {
          agentId: "11111111-1111-4111-8111-111111111122",
          budgetMonthlyCents: 5000,
        },
        {
          db: {} as never,
          companyId,
          actor: { type: "user", id: "user-1" },
        } as never,
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Use set_budget instead of update_agent for budget changes",
    });
  });

  it("create_invite apply keeps token in response details but strips it from auditDetails", async () => {
    mockInviteCreate.mockResolvedValue({
      invite: {
        id: "invite-1",
        inviteType: "link",
        allowedJoinTypes: "both",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      humanRole: "operator",
      inviteMessage: null,
      token: "raw-invite-token",
      invitePath: "/join/invite-1",
    });

    const tool = getTool("create_invite");
    expect(isMutationTool(tool)).toBe(true);

    await expect(
      tool.apply(
        {},
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).resolves.toMatchObject({
      details: {
        inviteId: "invite-1",
        token: "raw-invite-token",
        invitePath: "/join/invite-1",
      },
      auditDetails: {
        inviteId: "invite-1",
        invitePath: "/join/invite-1",
      },
    });
  });

  it("routine trigger secret appliers keep secrets out of auditDetails", async () => {
    mockRoutineGet.mockResolvedValue({
      id: "routine-1",
      companyId,
    });
    mockRoutineGetTrigger.mockResolvedValue({
      id: "trigger-1",
      companyId,
      routineId: "routine-1",
      kind: "webhook",
    });
    mockRoutineCreateTrigger.mockResolvedValue({
      trigger: {
        id: "trigger-1",
        routineId: "routine-1",
        kind: "webhook",
      },
      secretMaterial: {
        currentSecret: "raw-webhook-secret",
      },
    });
    mockRoutineRotateTriggerSecret.mockResolvedValue({
      trigger: {
        id: "trigger-1",
        routineId: "routine-1",
        kind: "webhook",
      },
      secretMaterial: {
        currentSecret: "rotated-webhook-secret",
      },
    });

    const createTool = getTool("create_routine_trigger");
    const rotateTool = getTool("rotate_routine_trigger_secret");
    expect(isMutationTool(createTool)).toBe(true);
    expect(isMutationTool(rotateTool)).toBe(true);

    await expect(
      createTool.apply(
        {
          routineId: "routine-1",
          input: { kind: "webhook" },
        },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).resolves.toMatchObject({
      details: {
        secretMaterial: {
          currentSecret: "raw-webhook-secret",
        },
      },
      auditDetails: {
        routineId: "routine-1",
        triggerId: "trigger-1",
        kind: "webhook",
      },
    });

    await expect(
      rotateTool.apply(
        {
          triggerId: "trigger-1",
        },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).resolves.toMatchObject({
      details: {
        currentSecret: "rotated-webhook-secret",
      },
      auditDetails: {
        routineId: "routine-1",
        triggerId: "trigger-1",
        kind: "webhook",
      },
    });
  });

  it("blocks approve_approval for approvals linked to builder proposals", async () => {
    mockApprovalGetById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "hire_agent",
    });
    mockBuilderProposalGetByApprovalId.mockResolvedValue({
      id: "proposal-1",
      companyId,
      approvalId: "approval-1",
    });

    const tool = getTool("approve_approval");
    expect(isMutationTool(tool)).toBe(true);

    await expect(
      tool.apply(
        { approvalId: "approval-1" },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).rejects.toThrow("This approval must be resolved from the Approvals queue");

    expect(mockApprovalApprove).not.toHaveBeenCalled();
  });

  it("blocks reject_approval for approvals linked to builder proposals", async () => {
    mockApprovalGetById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "hire_agent",
    });
    mockBuilderProposalGetByApprovalId.mockResolvedValue({
      id: "proposal-1",
      companyId,
      approvalId: "approval-1",
    });

    const tool = getTool("reject_approval");
    expect(isMutationTool(tool)).toBe(true);

    await expect(
      tool.apply(
        { approvalId: "approval-1" },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).rejects.toThrow("This approval must be resolved from the Approvals queue");

    expect(mockApprovalReject).not.toHaveBeenCalled();
  });
});
