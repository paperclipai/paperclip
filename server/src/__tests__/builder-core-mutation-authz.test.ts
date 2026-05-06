import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCoreMutationTools } from "../services/builder/tools/core-mutation.js";
import { isMutationTool } from "../services/builder/tools/mutation-tool.js";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockRoutineGet = vi.hoisted(() => vi.fn());
const mockRunRoutine = vi.hoisted(() => vi.fn());
const mockRoutineGetTrigger = vi.hoisted(() => vi.fn());
const mockProjectGetById = vi.hoisted(() => vi.fn());
const mockProjectCreate = vi.hoisted(() => vi.fn());
const mockProjectUpdate = vi.hoisted(() => vi.fn());
const mockAgentGetById = vi.hoisted(() => vi.fn());
const mockApprovalApprove = vi.hoisted(() => vi.fn());
const mockApprovalGetById = vi.hoisted(() => vi.fn());
const mockApprovalReject = vi.hoisted(() => vi.fn());
const mockBuilderProposalGetByApprovalId = vi.hoisted(() => vi.fn());
const mockGoalGetById = vi.hoisted(() => vi.fn());

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
  inviteService: () => ({}),
  issueService: () => ({}),
  projectService: () => ({
    getById: mockProjectGetById,
    create: mockProjectCreate,
    update: mockProjectUpdate,
  }),
  routineService: () => ({
    get: mockRoutineGet,
    getTrigger: mockRoutineGetTrigger,
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

  it("rejects create_project apply when deprecated goalId belongs to another company", async () => {
    mockGoalGetById.mockResolvedValue({
      id: "goal-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("create_project");
    expect(isMutationTool(tool)).toBe(true);

    await expect(
      tool.apply(
        {
          name: "Project X",
          goalId: "11111111-1111-4111-8111-111111111117",
        },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).rejects.toThrow("Goal not found");

    expect(mockProjectCreate).not.toHaveBeenCalled();
  });

  it("rejects update_project apply when deprecated goalId belongs to another company", async () => {
    mockProjectGetById.mockResolvedValue({
      id: "project-1",
      companyId,
    });
    mockGoalGetById.mockResolvedValue({
      id: "goal-foreign",
      companyId: otherCompanyId,
    });

    const tool = getTool("update_project");
    expect(isMutationTool(tool)).toBe(true);

    await expect(
      tool.apply(
        {
          projectId: "11111111-1111-4111-8111-111111111118",
          patch: {
            goalId: "11111111-1111-4111-8111-111111111119",
          },
        },
        {
          db: {} as never,
          companyId,
          decidedByUserId: "user-1",
        } as never,
      ),
    ).rejects.toThrow("Goal not found");

    expect(mockProjectUpdate).not.toHaveBeenCalled();
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
