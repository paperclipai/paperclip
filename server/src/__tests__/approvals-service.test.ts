import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalService,
  LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
} from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
  decisionNote?: string | null;
  decidedByUserId?: string | null;
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

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

type LinkedIssueRow = { issueId: string; status: string };

function createObsoleteReconcileDbStub(opts: {
  approval: ApprovalRecord;
  linkedIssues: LinkedIssueRow[];
  updateResult?: ApprovalRecord | null;
}) {
  const approvalLookups = [opts.approval];
  let linkedIssuesCalls = 0;
  let openApprovalsForIssueCalls = 0;
  let lastSetValues: Record<string, unknown> | null = null;

  const selectHandlers: Array<() => Promise<unknown[]>> = [];
  // 1) getExistingApproval (cancelObsoleteWhenLinkedIssuesTerminal)
  selectHandlers.push(async () => {
    const next = approvalLookups.shift();
    return next ? [next] : [];
  });
  // 2) listLinkedIssueStatuses
  selectHandlers.push(async () => {
    linkedIssuesCalls += 1;
    return opts.linkedIssues;
  });
  // 3) getExistingApproval again inside resolveApproval (only used when cancelling)
  if (opts.updateResult) {
    selectHandlers.push(async () => [opts.approval]);
  }

  let selectCall = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => {
        const handler = selectHandlers[selectCall++] ?? (async () => []);
        return handler();
      }),
      innerJoin: vi.fn(() => ({
        where: vi.fn(async () => {
          const handler = selectHandlers[selectCall++] ?? (async () => []);
          return handler();
        }),
      })),
    })),
  }));

  const returning = vi.fn(async () => (opts.updateResult ? [opts.updateResult] : []));
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn((values: Record<string, unknown>) => {
    lastSetValues = values;
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    get lastSetValues() {
      return lastSetValues;
    },
    linkedIssuesCalls: () => linkedIssuesCalls,
    openApprovalsForIssueCalls: () => openApprovalsForIssueCalls,
    bumpOpenApprovalsHandler(rows: Array<{ id: string }>) {
      selectHandlers.splice(selectCall, 0, async () => {
        openApprovalsForIssueCalls += 1;
        return rows;
      });
    },
    pushApprovalLookup(approval: ApprovalRecord) {
      selectHandlers.push(async () => [approval]);
    },
    pushLinkedIssues(rows: LinkedIssueRow[]) {
      selectHandlers.push(async () => {
        linkedIssuesCalls += 1;
        return rows;
      });
    },
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
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
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});

describe("approvalService obsolete linked-issue cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels pending approvals when every linked issue is terminal", async () => {
    const pending = {
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: { title: "Force release" },
    };
    const cancelled = {
      ...pending,
      status: "cancelled",
      decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      decidedByUserId: "system",
    };
    const stub = createObsoleteReconcileDbStub({
      approval: pending,
      linkedIssues: [
        { issueId: "issue-1", status: "done" },
        { issueId: "issue-2", status: "cancelled" },
      ],
      updateResult: cancelled,
    });

    const svc = approvalService(stub.db as any);
    const result = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("cancelled");
    expect(result.approval.decisionNote).toBe(LINKED_ISSUES_TERMINAL_CANCEL_NOTE);
    expect(stub.lastSetValues).toEqual(
      expect.objectContaining({
        status: "cancelled",
        decidedByUserId: "system",
        decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      }),
    );
    // Non-hire approvals never call terminate.
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("terminates pending hire_agent agents when obsolete-cancelling linked approvals", async () => {
    const pending = createApproval("pending");
    const cancelled = {
      ...pending,
      status: "cancelled",
      decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      decidedByUserId: "system",
    };
    const stub = createObsoleteReconcileDbStub({
      approval: pending,
      linkedIssues: [{ issueId: "issue-1", status: "done" }],
      updateResult: cancelled,
    });

    const svc = approvalService(stub.db as any);
    const result = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("cancelled");
    expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1");
  });

  it("leaves mixed terminal/open linked approvals actionable", async () => {
    const pending = {
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: { title: "Still needed" },
    };
    const stub = createObsoleteReconcileDbStub({
      approval: pending,
      linkedIssues: [
        { issueId: "issue-1", status: "done" },
        { issueId: "issue-2", status: "in_progress" },
      ],
    });

    const svc = approvalService(stub.db as any);
    const result = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("pending");
    expect(stub.lastSetValues).toBeNull();
  });

  it("does not cancel open approvals with no linked issues", async () => {
    const pending = createApproval("pending");
    const stub = createObsoleteReconcileDbStub({
      approval: pending,
      linkedIssues: [],
    });

    const svc = approvalService(stub.db as any);
    const result = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("pending");
    expect(stub.lastSetValues).toBeNull();
  });

  it("treats repeated obsolete cancellation as a no-op that preserves the first cancellation", async () => {
    const cancelled = {
      ...createApproval("cancelled"),
      type: "request_board_approval",
      payload: { title: "Force release" },
      decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      decidedByUserId: "system",
    };
    // Already-cancelled approvals return before linked-issue reads; only getExisting runs.
    const dbStub = createDbStub([[cancelled], [cancelled]], []);

    const svc = approvalService(dbStub.db as any);
    const first = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");
    const second = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(first.applied).toBe(false);
    expect(second.applied).toBe(false);
    expect(second.approval.decisionNote).toBe(LINKED_ISSUES_TERMINAL_CANCEL_NOTE);
    expect(first.approval.decisionNote).toBe(LINKED_ISSUES_TERMINAL_CANCEL_NOTE);
  });

  it("cancels revision_requested approvals when linked issues are all terminal", async () => {
    const revision = {
      ...createApproval("revision_requested"),
      type: "request_board_approval",
      payload: { title: "Needs revision then became obsolete" },
    };
    const cancelled = {
      ...revision,
      status: "cancelled",
      decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      decidedByUserId: "system",
    };
    const stub = createObsoleteReconcileDbStub({
      approval: revision,
      linkedIssues: [{ issueId: "issue-1", status: "done" }],
      updateResult: cancelled,
    });

    const svc = approvalService(stub.db as any);
    const result = await svc.cancelObsoleteWhenLinkedIssuesTerminal("approval-1");

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("cancelled");
  });

  it("reconcileObsoleteForIssue cancels only approvals whose full link set is terminal", async () => {
    const obsolete = {
      ...createApproval("pending"),
      id: "approval-obsolete",
      type: "request_board_approval",
      payload: { title: "Obsolete" },
    };
    const stillOpen = {
      ...createApproval("pending"),
      id: "approval-open",
      type: "request_board_approval",
      payload: { title: "Still open sibling" },
    };
    const cancelled = {
      ...obsolete,
      status: "cancelled",
      decisionNote: LINKED_ISSUES_TERMINAL_CANCEL_NOTE,
      decidedByUserId: "system",
    };

    const stub = createObsoleteReconcileDbStub({
      approval: obsolete,
      linkedIssues: [{ issueId: "issue-1", status: "done" }],
      updateResult: cancelled,
    });
    // reconcileObsoleteForIssue first query: open approvals for the issue
    stub.bumpOpenApprovalsHandler([{ id: "approval-obsolete" }, { id: "approval-open" }]);
    // After cancelling obsolete, cancelObsolete for approval-open:
    stub.pushApprovalLookup(stillOpen);
    stub.pushLinkedIssues([
      { issueId: "issue-1", status: "done" },
      { issueId: "issue-2", status: "todo" },
    ]);

    const svc = approvalService(stub.db as any);
    const results = await svc.reconcileObsoleteForIssue("issue-1");

    expect(results).toHaveLength(2);
    expect(results[0]?.applied).toBe(true);
    expect(results[0]?.approval.id).toBe("approval-obsolete");
    expect(results[1]?.applied).toBe(false);
    expect(results[1]?.approval.id).toBe("approval-open");
  });
});
