import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createAgentOsApproval(status: string, payloadPatch: Record<string, unknown> = {}): ApprovalRecord {
  return {
    id: "approval-agent-os-1",
    companyId: "company-1",
    type: "request_board_approval",
    status,
    payload: {
      version: 1,
      surface: "agent_os",
      action: "ready_agent_provision_preview",
      approvalScope: "ready_agent_provisioning",
      approvalOnly: false,
      liveApply: true,
      liveExecution: false,
      liveExternalActions: false,
      blueprint: {
        key: "ceo-pm",
        title: "CEO/PM",
        category: "leadership",
        requiredSkillRefs: ["paperclip-agent-operations"],
        mcpBundleRefs: [],
      },
      readiness: { ready: true, checks: [] },
      requiredSecretNames: [],
      ...payloadPatch,
    },
    requestedByAgentId: "requester-1",
  };
}

function withAgentOsApply(approval: ApprovalRecord): ApprovalRecord {
  return {
    ...approval,
    payload: {
      ...approval.payload,
      agentOsApply: {
        source: "agent_os_apply_service",
        version: 1,
        status: "succeeded",
        action: "ready_agent_provision_preview",
        approvalId: approval.id,
        idempotencyKey: `agent_os:${approval.id}:ready_agent_provision_preview`,
        liveExternalActions: false,
        startedAt: "2026-05-14T09:00:00.000Z",
        completedAt: "2026-05-14T09:00:01.000Z",
        result: {
          agentId: "agent-1",
          agentName: "CEO/PM",
          blueprintKey: "ceo-pm",
          reusedExisting: false,
        },
      },
    },
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[] | ApprovalRecord[][]) {
  const pendingSelectResults = [...selectResults];
  const pendingUpdateResults = Array.isArray(updateResults[0])
    ? ([...(updateResults as ApprovalRecord[][])] as ApprovalRecord[][])
    : [updateResults as ApprovalRecord[]];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => pendingUpdateResults.shift() ?? []);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("executes the Agent OS live apply engine only after a new approval transition", async () => {
    const approved = createAgentOsApproval("approved");
    const appliedApproval = withAgentOsApply(approved);
    const dbStub = createDbStub(
      [[createAgentOsApproval("pending")]],
      [[approved], [appliedApproval]],
    );
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.create.mockResolvedValue({ id: "agent-1", name: "CEO/PM" });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-agent-os-1", "board", "apply it");

    expect(result.applied).toBe(true);
    expect(result.approval.payload).toMatchObject({
      agentOsApply: {
        status: "succeeded",
        action: "ready_agent_provision_preview",
        result: { agentId: "agent-1", reusedExisting: false },
      },
    });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "CEO/PM",
        metadata: expect.objectContaining({
          agentOs: expect.objectContaining({ approvalId: "approval-agent-os-1", blueprintKey: "ceo-pm" }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board",
        action: "agent_os_apply_succeeded",
        entityType: "approval",
        entityId: "approval-agent-os-1",
        agentId: "agent-1",
      }),
    );
  });

  it("reconciles Agent OS apply on an idempotent repeated approval when apply status is missing", async () => {
    const alreadyApproved = createAgentOsApproval("approved");
    const appliedApproval = withAgentOsApply(alreadyApproved);
    const dbStub = createDbStub([[alreadyApproved]], [[appliedApproval]]);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.create.mockResolvedValue({ id: "agent-1", name: "CEO/PM" });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-agent-os-1", "board", "retry");

    expect(result.applied).toBe(false);
    expect(result.approval.payload).toMatchObject({
      agentOsApply: {
        source: "agent_os_apply_service",
        status: "succeeded",
        result: { agentId: "agent-1", reusedExisting: false },
      },
    });
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
  });

  it("does not execute Agent OS live apply again when repeated approval already has a server apply record", async () => {
    const alreadyApproved = withAgentOsApply(createAgentOsApproval("approved"));
    const dbStub = createDbStub([[alreadyApproved]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-agent-os-1", "board", "retry");

    expect(result.applied).toBe(false);
    expect(mockAgentService.list).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});
