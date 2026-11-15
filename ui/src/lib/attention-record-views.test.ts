import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { attentionRecordQueryKeys } from "./attention-record-views";
import { queryKeys } from "./queryKeys";

function item(sourceKind: AttentionItem["sourceKind"], subject: Partial<AttentionItem["subject"]>, overrides: Partial<AttentionItem> = {}) {
  return {
    id: `${sourceKind}-card`,
    sourceKind,
    subject: { id: "source-1", metadata: {}, ...subject },
    relatedIssue: null,
    ...overrides,
  } as unknown as AttentionItem;
}

describe("attentionRecordQueryKeys (PAP-771: one record, many views)", () => {
  it("refreshes the task's interactions under both its UUID and identifier, plus chat", () => {
    const keys = attentionRecordQueryKeys("company-1", item(
      "issue_thread_interaction",
      { metadata: { issueId: "issue-1" } },
      { relatedIssue: { id: "issue-1", identifier: "NEE-39" } as AttentionItem["relatedIssue"] },
    ));
    expect(keys).toEqual([
      queryKeys.attention("company-1"),
      queryKeys.issues.interactions("issue-1"),
      queryKeys.issues.interactions("NEE-39"),
      ["issues", "pending-questions"],
      ["issues", "decision-receipts"],
    ]);
  });

  it("refreshes an open approval page and every approval list", () => {
    expect(attentionRecordQueryKeys("company-1", item("approval", { id: "approval-1" }))).toEqual([
      queryKeys.attention("company-1"),
      ["approvals", "company-1"],
      queryKeys.approvals.detail("approval-1"),
    ]);
  });

  it("refreshes an open decision, whose detail key sits outside the company prefix", () => {
    expect(attentionRecordQueryKeys("company-1", item("decision", { id: "decision-1" }))).toContainEqual(
      queryKeys.decisions.detail("decision-1"),
    );
  });

  it("refreshes the budget page and the hard stop's folded override approval", () => {
    expect(attentionRecordQueryKeys("company-1", item("budget_alert", { id: "incident-1", metadata: { approvalId: "approval-9" } }))).toEqual([
      queryKeys.attention("company-1"),
      queryKeys.budgets.overview("company-1"),
      ["approvals", "company-1"],
      queryKeys.approvals.detail("approval-9"),
    ]);
  });

  it("keeps join requests on their own list", () => {
    expect(attentionRecordQueryKeys("company-1", item("join_request", { id: "join-1" }))).toEqual([
      queryKeys.attention("company-1"),
      queryKeys.access.joinRequests("company-1"),
    ]);
  });
});
