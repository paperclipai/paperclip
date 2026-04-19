import { describe, expect, it, vi } from "vitest";
import { issueApprovalService } from "../services/issue-approvals.js";

function createDbWithNoIssueOrApproval() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

describe("services/issue-approvals.ts", () => {
  it("returns notFound when listing approvals for a missing issue", async () => {
    const service = issueApprovalService(createDbWithNoIssueOrApproval() as any);
    await expect(service.listApprovalsForIssue("issue-missing")).rejects.toThrow("Issue not found");
  });

  it("returns notFound when listing issues for a missing approval", async () => {
    const service = issueApprovalService(createDbWithNoIssueOrApproval() as any);
    await expect(service.listIssuesForApproval("approval-missing")).rejects.toThrow("Approval not found");
  });
});

