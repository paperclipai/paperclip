import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { executeApprovedSecretOperation } from "../services/secret-approval-hook.js";
import { redactEventPayload } from "../redaction.js";

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => mockSecretService),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => mockIssueService),
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: vi.fn(() => mockIssueApprovalService),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { logActivity } = await import("../services/activity-log.js");

const db = {} as Db;
const TARGET = "3f1c0b6e-5f0a-4a2e-9b1d-8c7a6e5d4c3b";

function activityActions() {
  return (logActivity as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => (call[1] as { action: string }).action,
  );
}

function activityDetails(action: string) {
  const call = (logActivity as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    (entry) => (entry[1] as { action: string }).action === action,
  );
  return (call?.[1] as { details: Record<string, unknown> } | undefined)?.details;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretService.getById.mockResolvedValue({
    id: TARGET,
    companyId: "company-1",
    scope: "company",
    status: "active",
  });
  mockSecretService.update.mockResolvedValue({ id: TARGET });
  mockSecretService.remove.mockResolvedValue({ id: TARGET });
  mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
  mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
});

describe("executeApprovedSecretOperation", () => {
  it("renames through the secret service and never touches the value", async () => {
    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "rename", targetId: TARGET, newName: "gateway-client-secret" },
    });

    expect(result).toEqual({ ok: true, op: "rename", targetId: TARGET, error: null });
    // Name only: no value, no key, no status — a rename cannot rotate anything.
    expect(mockSecretService.update).toHaveBeenCalledWith(TARGET, {
      name: "gateway-client-secret",
    });
    expect(mockSecretService.remove).not.toHaveBeenCalled();
  });

  it("deletes through the secret service so access events and cache invalidation still run", async () => {
    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result.ok).toBe(true);
    expect(mockSecretService.remove).toHaveBeenCalledWith(TARGET);
    expect(mockSecretService.update).not.toHaveBeenCalled();
  });

  it("keeps the identifying payload keys readable through redaction", () => {
    // `targetId` is deliberately not a secret-shaped key name: older redactor
    // patterns blanked `secretId` on every read route, which left a board card
    // unable to say which secret it authorizes.
    const stored = { op: "rename", targetId: TARGET, newName: "gateway-client-secret" };
    const shown = redactEventPayload({ ...stored }) as Record<string, unknown>;

    expect(shown.targetId).toBe(TARGET);
    expect(shown.newName).toBe("gateway-client-secret");
    expect(shown.op).toBe("rename");
  });

  it("applies the operation from a payload that redaction would mangle on read", async () => {
    const stored = { op: "delete", targetId: TARGET };
    await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: stored,
    });

    // The hook reads the row, never the redacted read-model.
    expect(mockSecretService.remove).toHaveBeenCalledWith(TARGET);
  });

  it("rejects a payload carrying anything beyond the operation, including a value", async () => {
    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "rename", targetId: TARGET, newName: "new-name", value: "super-secret" },
    });

    expect(result.ok).toBe(false);
    expect(mockSecretService.update).not.toHaveBeenCalled();
    expect(result.error).toContain("invalid secret_operation payload");
    // The rejection must not echo what was submitted.
    expect(result.error).not.toContain("super-secret");
  });

  it("logs the applied operation without the secret name", async () => {
    await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "rename", targetId: TARGET, newName: "gateway-client-secret" },
    });

    expect(activityActions()).toContain("approval.secret_operation.applied");
    const details = activityDetails("approval.secret_operation.applied");
    // For some rows the name *is* the credential, so it never reaches the log.
    expect(details).toEqual({ op: "rename", targetId: TARGET });
  });

  it("fails loudly to the activity log and the linked issue when the operation throws", async () => {
    mockSecretService.remove.mockRejectedValue(new Error("provider unavailable"));

    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result).toEqual({
      ok: false,
      op: "delete",
      targetId: TARGET,
      error: "provider unavailable",
    });
    expect(activityActions()).toContain("approval.secret_operation.failed");
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const [issueId, body] = mockIssueService.addComment.mock.calls[0];
    expect(issueId).toBe("issue-1");
    expect(body).toContain("Approved secret operation failed");
    expect(body).toContain("provider unavailable");
  });

  it("treats a missing secret as a failure rather than a silent success", async () => {
    mockSecretService.remove.mockResolvedValue(null);

    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("secret not found");
    expect(activityActions()).toContain("approval.secret_operation.failed");
  });

  it("still reports the operation outcome when commenting on the linked issue fails", async () => {
    mockIssueService.addComment.mockRejectedValue(new Error("issue is closed"));

    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result.ok).toBe(true);
    expect(activityActions()).toContain("approval.secret_operation.applied");
  });

  it.each(["rename", "delete"] as const)(
    "refuses to %s a secret owned by another company",
    async (op) => {
      mockSecretService.getById.mockResolvedValue({
        id: TARGET,
        companyId: "company-2",
        scope: "company",
        status: "active",
      });

      const result = await executeApprovedSecretOperation(db, {
        companyId: "company-1",
        approvalId: "approval-1",
        payload: op === "rename" ? { op, targetId: TARGET, newName: "x" } : { op, targetId: TARGET },
      });

      expect(result.ok).toBe(false);
      // Same message as a missing id: the foreign secret's existence is not confirmed.
      expect(result.error).toBe("secret not found");
      expect(mockSecretService.update).not.toHaveBeenCalled();
      expect(mockSecretService.remove).not.toHaveBeenCalled();
      expect(activityActions()).toContain("approval.secret_operation.failed");
    },
  );

  it("refuses a secret that is not company-scoped", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: TARGET,
      companyId: "company-1",
      scope: "user",
      status: "active",
    });

    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result.ok).toBe(false);
    expect(mockSecretService.remove).not.toHaveBeenCalled();
  });

  it("keeps notifying the remaining linked issues when one comment fails", async () => {
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1" },
      { id: "issue-2" },
    ]);
    mockIssueService.addComment
      .mockRejectedValueOnce(new Error("issue is closed"))
      .mockResolvedValueOnce({ id: "comment-2" });

    const result = await executeApprovedSecretOperation(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      payload: { op: "delete", targetId: TARGET },
    });

    expect(result.ok).toBe(true);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment.mock.calls[1][0]).toBe("issue-2");
  });
});
