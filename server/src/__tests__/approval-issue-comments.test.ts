import { describe, expect, it } from "vitest";
import { buildApprovalSystemCommentBody } from "../services/approval-issue-comments.js";

const baseApproval = {
  id: "approval-1",
  type: "request_board_approval",
  status: "pending",
  payload: { title: "Approve monthly hosting spend" },
  decisionNote: null,
};

describe("buildApprovalSystemCommentBody", () => {
  it("formats a created comment with company-prefixed approval link", () => {
    const body = buildApprovalSystemCommentBody({
      event: "created",
      approval: baseApproval,
      issuePrefix: "ZERA",
      requesterAgentName: "CPO",
    });
    expect(body).toContain("## Pending board approval");
    expect(body).toContain("[Approve monthly hosting spend](/ZERA/approvals/approval-1)");
    expect(body).toContain("`request_board_approval`");
    expect(body).toContain("Requested by CPO.");
  });

  it("formats an approved comment and includes the decision note when present", () => {
    const body = buildApprovalSystemCommentBody({
      event: "approved",
      approval: { ...baseApproval, status: "approved", decisionNote: "Endorsed by CEO." },
      issuePrefix: "PAP",
    });
    expect(body).toContain("## Board approval granted");
    expect(body).toContain("[Approve monthly hosting spend](/PAP/approvals/approval-1) approved.");
    expect(body).toContain("**Decision note:** Endorsed by CEO.");
  });

  it("formats a rejected comment without a decision note when none is provided", () => {
    const body = buildApprovalSystemCommentBody({
      event: "rejected",
      approval: { ...baseApproval, status: "rejected", decisionNote: null },
      issuePrefix: "PAP",
    });
    expect(body).toContain("## Board approval rejected");
    expect(body).toContain("[Approve monthly hosting spend](/PAP/approvals/approval-1) rejected.");
    expect(body).not.toContain("Decision note");
  });

  it("treats whitespace-only decision notes as absent", () => {
    const body = buildApprovalSystemCommentBody({
      event: "approved",
      approval: { ...baseApproval, decisionNote: "   \n  " },
      issuePrefix: "PAP",
    });
    expect(body).not.toContain("Decision note");
  });

  it("formats a revision_requested comment", () => {
    const body = buildApprovalSystemCommentBody({
      event: "revision_requested",
      approval: { ...baseApproval, status: "revision_requested", decisionNote: "Please tighten the risks section." },
      issuePrefix: "ZERA",
    });
    expect(body).toContain("## Board requested revision");
    expect(body).toContain("sent back for revision.");
    expect(body).toContain("**Decision note:** Please tighten the risks section.");
  });

  it("formats a resubmitted comment", () => {
    const body = buildApprovalSystemCommentBody({
      event: "resubmitted",
      approval: { ...baseApproval, status: "pending" },
      issuePrefix: "ZERA",
      requesterAgentName: "CPO",
    });
    expect(body).toContain("## Approval resubmitted");
    expect(body).toContain("resubmitted to the board (status `pending`).");
    expect(body).toContain("Requested by CPO.");
  });

  it("falls back to a generic title when payload title is missing or empty", () => {
    const body = buildApprovalSystemCommentBody({
      event: "created",
      approval: { ...baseApproval, payload: { title: "   " } },
      issuePrefix: "ZERA",
    });
    expect(body).toContain("[Board approval](/ZERA/approvals/approval-1)");
  });

  it("escapes nothing — payload title is rendered verbatim into the markdown link", () => {
    const body = buildApprovalSystemCommentBody({
      event: "created",
      approval: { ...baseApproval, payload: { title: "Spend $500/month on hosting" } },
      issuePrefix: "ZERA",
    });
    expect(body).toContain("[Spend $500/month on hosting](/ZERA/approvals/approval-1)");
  });
});
