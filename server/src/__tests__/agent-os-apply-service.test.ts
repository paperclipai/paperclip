import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentOsApprovalApplyService } from "../services/agent-os-apply.ts";

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
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
};

function readyAgentApproval(payloadPatch: Record<string, unknown> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "approved",
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
        requiredSkillRefs: ["paperclip-agent-operations", "writing-plans"],
        mcpBundleRefs: [],
      },
      readiness: {
        ready: true,
        checks: [{ key: "permission_review", status: "pass", message: "Reviewed." }],
      },
      requiredSecretNames: [],
      ...payloadPatch,
    },
  };
}

function dbStub(updatedApproval: ApprovalRecord) {
  const returning = vi.fn(async () => [updatedApproval]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update }, set, where, returning };
}

describe("agentOsApprovalApplyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.create.mockResolvedValue({ id: "agent-1", name: "CEO/PM" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("provisions a ready-agent blueprint when an Agent OS approval is approved", async () => {
    const approval = readyAgentApproval();
    const stub = dbStub(approval);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(result.apply.action).toBe("ready_agent_provision_preview");
    expect(result.apply.result).toMatchObject({ agentId: "agent-1", agentName: "CEO/PM", reusedExisting: false });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "CEO/PM",
        role: "leadership",
        title: "CEO/PM",
        adapterType: "hermes_local",
        status: "idle",
        metadata: expect.objectContaining({
          agentOs: expect.objectContaining({
            approvalId: "approval-1",
            blueprintKey: "ceo-pm",
            provisionedByUserId: "board-user",
          }),
        }),
      }),
    );
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          liveApply: true,
          approvalOnly: false,
          agentOsApply: expect.objectContaining({
            source: "agent_os_apply_service",
            status: "succeeded",
            action: "ready_agent_provision_preview",
          }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      stub.db,
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        action: "agent_os_apply_succeeded",
        entityType: "approval",
        entityId: "approval-1",
        agentId: "agent-1",
        details: expect.objectContaining({
          idempotencyKey: "agent_os:approval-1:ready_agent_provision_preview",
          liveExternalActions: false,
          result: expect.objectContaining({ agentId: "agent-1", reusedExisting: false }),
        }),
      }),
    );
  });

  it("is idempotent when the blueprint was already provisioned", async () => {
    const approval = readyAgentApproval();
    const stub = dbStub(approval);
    mockAgentService.list.mockResolvedValue([
      {
        id: "agent-existing",
        name: "CEO/PM",
        status: "idle",
        metadata: { agentOs: { blueprintKey: "ceo-pm", approvalId: "earlier-approval" } },
      },
    ]);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(result.apply.result).toMatchObject({ agentId: "agent-existing", reusedExisting: true });
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          agentOsApply: expect.objectContaining({
            status: "succeeded",
            result: expect.objectContaining({ reusedExisting: true }),
          }),
        }),
      }),
    );
  });

  it("does not reuse an unrelated agent solely by display name", async () => {
    const approval = readyAgentApproval();
    const stub = dbStub(approval);
    mockAgentService.list.mockResolvedValue([
      {
        id: "agent-unrelated",
        name: "CEO/PM",
        status: "idle",
        metadata: { agentOs: { blueprintKey: "different-blueprint", approvalId: "other-approval" } },
      },
    ]);
    mockAgentService.create.mockResolvedValue({ id: "agent-new", name: "CEO/PM" });

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(result.apply.result).toMatchObject({ agentId: "agent-new", reusedExisting: false });
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
  });

  it("skips live apply when a payload asks for external live actions", async () => {
    const approval = readyAgentApproval({ liveExternalActions: true });
    const stub = dbStub(approval);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("skipped");
    expect(result.apply.errorCode).toBe("live_apply_not_requested");
    expect(mockAgentService.list).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          liveExternalActions: true,
          agentOsApply: expect.objectContaining({
            status: "skipped",
            errorCode: "live_apply_not_requested",
            liveExternalActions: false,
          }),
        }),
      }),
    );
  });

  it("requires explicit internal-only live apply flags before executing", async () => {
    const cases = [
      { name: "missing approvalOnly", patch: { approvalOnly: undefined } },
      { name: "missing liveExternalActions", patch: { liveExternalActions: undefined } },
      { name: "string approvalOnly", patch: { approvalOnly: "false" } },
      { name: "string liveExternalActions", patch: { liveExternalActions: "false" } },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      mockAgentService.list.mockResolvedValue([]);
      mockAgentService.create.mockResolvedValue({ id: "agent-1", name: "CEO/PM" });
      mockLogActivity.mockResolvedValue(undefined);
      const approval = readyAgentApproval(testCase.patch);
      const stub = dbStub(approval);

      const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

      expect(result.apply.status, testCase.name).toBe("skipped");
      expect(result.apply.errorCode, testCase.name).toBe("live_apply_not_requested");
      expect(mockAgentService.list, testCase.name).not.toHaveBeenCalled();
      expect(mockAgentService.create, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("ignores caller-supplied apply records and still executes the approved action", async () => {
    const approval = readyAgentApproval({
      agentOsApply: {
        version: 1,
        status: "succeeded",
        action: "ready_agent_provision_preview",
        approvalId: "approval-1",
        idempotencyKey: "agent_os:approval-1:ready_agent_provision_preview",
        liveExternalActions: false,
        startedAt: "2026-05-14T09:00:00.000Z",
        completedAt: "2026-05-14T09:00:01.000Z",
        result: { agentId: "spoofed-agent", reusedExisting: true },
      },
    });
    const stub = dbStub(approval);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(result.apply.result).toMatchObject({ agentId: "agent-1", reusedExisting: false });
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          agentOsApply: expect.objectContaining({
            source: "agent_os_apply_service",
            result: expect.objectContaining({ agentId: "agent-1" }),
          }),
        }),
      }),
    );
  });

  it("strips malformed server-looking apply records at the service boundary before trusting idempotency", async () => {
    const approval = readyAgentApproval({
      agentOsApply: {
        source: "agent_os_apply_service",
        version: 1,
        status: "succeeded",
        action: "ready_agent_provision_preview",
        approvalId: "approval-1",
        idempotencyKey: "agent_os:other-approval:ready_agent_provision_preview",
        liveExternalActions: false,
        startedAt: "2026-05-14T09:00:00.000Z",
        completedAt: "2026-05-14T09:00:01.000Z",
        result: { agentId: "spoofed-agent", reusedExisting: true },
      },
    });
    const stub = dbStub(approval);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(result.apply.result).toMatchObject({ agentId: "agent-1", reusedExisting: false });
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          agentOsApply: expect.objectContaining({
            source: "agent_os_apply_service",
            idempotencyKey: "agent_os:approval-1:ready_agent_provision_preview",
            result: expect.objectContaining({ agentId: "agent-1" }),
          }),
        }),
      }),
    );
  });

  it("records and safely logs a failed apply result when the internal executor throws", async () => {
    const approval = readyAgentApproval();
    const stub = dbStub(approval);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveKeyName = "api" + "Key";
    const sensitiveValue = "super-secret-value";
    mockAgentService.create.mockRejectedValueOnce(new Error(`adapter failed {"${sensitiveKeyName}":"${sensitiveValue}"}`));

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("failed");
    expect(result.apply.errorCode).toBe("live_apply_executor_failed");
    expect(result.apply.errorMessage).toBe("Ready-agent provisioning executor failed before completion.");
    expect(consoleError).toHaveBeenCalledWith(
      "[agent-os-apply] executor failed",
      expect.objectContaining({
        approvalId: "approval-1",
        action: "ready_agent_provision_preview",
        error: expect.stringContaining("adapter failed"),
      }),
    );
    const executorLog = consoleError.mock.calls.find(([message]) => message === "[agent-os-apply] executor failed")?.[1] as
      | { error?: string }
      | undefined;
    expect(executorLog?.error).toContain("***REDACTED***");
    expect(executorLog?.error).not.toContain("super-secret-value");
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          agentOsApply: expect.objectContaining({
            source: "agent_os_apply_service",
            status: "failed",
            errorCode: "live_apply_executor_failed",
          }),
        }),
      }),
    );
    consoleError.mockRestore();
  });

  it("logs an explicit error if the audit trail write fails", async () => {
    const approval = readyAgentApproval();
    const stub = dbStub(approval);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockLogActivity.mockRejectedValueOnce(new Error("audit offline"));

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("succeeded");
    expect(consoleError).toHaveBeenCalledWith(
      "[agent-os-apply] audit log write failed",
      expect.objectContaining({
        approvalId: "approval-1",
        action: "ready_agent_provision_preview",
        status: "succeeded",
        error: "audit offline",
      }),
    );
    consoleError.mockRestore();
  });

  it("records an explicit failed apply result for unsupported Agent OS actions instead of silently no-oping", async () => {
    const approval = readyAgentApproval({
      action: "mcp_install_preview",
      approvalScope: "mcp_marketplace_install",
      server: { catalogId: "github-readonly", title: "GitHub Readonly MCP" },
    });
    const stub = dbStub(approval);

    const result = await agentOsApprovalApplyService(stub.db as any).applyApprovedApproval(approval as any, "board-user");

    expect(result.apply.status).toBe("failed");
    expect(result.apply.errorCode).toBe("unsupported_agent_os_action");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(stub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          agentOsApply: expect.objectContaining({
            status: "failed",
            errorCode: "unsupported_agent_os_action",
          }),
        }),
      }),
    );
  });
});
