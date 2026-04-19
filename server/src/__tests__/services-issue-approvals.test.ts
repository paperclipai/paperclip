import { describe, expect, it, vi } from "vitest";
import { issueApprovalService } from "../services/issue-approvals.js";

function createDbWithSelectQueue(selectRows: Array<Array<Record<string, unknown>>>) {
  const pending = [...selectRows];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(pending.shift() ?? []),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  };
}

describe("services/issue-approvals.ts", () => {
  it("returns notFound when listing approvals for a missing issue", async () => {
    const service = issueApprovalService(createDbWithSelectQueue([[]]) as any);
    await expect(service.listApprovalsForIssue("issue-missing")).rejects.toThrow("Issue not found");
  });

  it("returns notFound when listing issues for a missing approval", async () => {
    const service = issueApprovalService(createDbWithSelectQueue([[]]) as any);
    await expect(service.listIssuesForApproval("approval-missing")).rejects.toThrow("Approval not found");
  });

  it("rejects links when issue and approval belong to different companies", async () => {
    const service = issueApprovalService(
      createDbWithSelectQueue([
        [{ id: "issue-1", companyId: "company-1" }],
        [{ id: "approval-1", companyId: "company-2" }],
      ]) as any,
    );

    await expect(service.link("issue-1", "approval-1")).rejects.toThrow(
      "Issue and approval must belong to the same company",
    );
  });

  it("fails batch linking when any requested issue id is missing", async () => {
    const service = issueApprovalService(
      createDbWithSelectQueue([
        [{ id: "approval-1", companyId: "company-1" }],
        [{ id: "issue-1", companyId: "company-1" }],
      ]) as any,
    );

    await expect(service.linkManyForApproval("approval-1", ["issue-1", "issue-2"])).rejects.toThrow(
      "One or more issues not found",
    );
  });
});

