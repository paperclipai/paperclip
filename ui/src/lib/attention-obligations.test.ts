import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import {
  attentionEvidenceLabel,
  attentionEvidenceText,
  attentionEvidenceToShow,
  attentionObligationEvidence,
  foldAttentionObligations,
  isAttentionObligationEvidence,
} from "./attention-obligations";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    sourceKind: "approval",
    subject: { kind: "approval", id, companyId: "c1", title: `Card ${id}`, identifier: null, status: null, href: `/PAP/x/${id}` },
    whyNow: `Why ${id}`,
    detail: null,
    obligationKey: null,
    obligationLeadId: null,
    ...overrides,
  } as AttentionItem;
}

describe("one card for each obligation (PAP-749 task 2d)", () => {
  const approval = item("approval:a1", { obligationKey: "approval:a1", obligationLeadId: "approval:a1" });
  const review = item("review:t1", {
    sourceKind: "review",
    subject: { kind: "issue", id: "t1", companyId: "c1", title: "Ship the page", identifier: "PAP-7", status: "in_review", href: "/PAP/issues/PAP-7" },
    whyNow: "Issue is in review with a linked pending approval.",
    obligationKey: "approval:a1",
    obligationLeadId: "approval:a1",
  });
  const solo = item("decision:d1", { sourceKind: "decision" });

  it("folds evidence into its lead and keeps every other card", () => {
    const folded = foldAttentionObligations([review, solo, approval]);
    expect(folded.cards.map((card) => card.id)).toEqual(["decision:d1", "approval:a1"]);
    expect(attentionObligationEvidence(folded, approval)).toEqual([review]);
    expect(attentionObligationEvidence(folded, solo)).toEqual([]);
    expect(isAttentionObligationEvidence(review)).toBe(true);
    expect(isAttentionObligationEvidence(approval)).toBe(false);
    expect(isAttentionObligationEvidence(solo)).toBe(false);
  });

  it("keeps evidence as its own card when its lead is not in the list", () => {
    const folded = foldAttentionObligations([review, solo]);
    expect(folded.cards.map((card) => card.id)).toEqual(["review:t1", "decision:d1"]);
    expect(folded.evidenceByLeadId.size).toBe(0);
  });

  it("names what each evidence card is to its lead", () => {
    const run = item("failed_run:run:r1", { sourceKind: "failed_run" });
    const blocked = item("blocker_attention:blocker:t2", { sourceKind: "blocker_attention" });
    const blockedOwner = item("blocker_attention:blocked-owner:t2", { sourceKind: "blocker_attention" });
    expect(attentionEvidenceLabel(approval, review)).toBe("Task waiting on this approval");
    expect(attentionEvidenceLabel(run, blocked)).toBe("Blocked by this run");
    expect(attentionEvidenceLabel(blockedOwner, blocked)).toBe("Blocked work");
    expect(attentionEvidenceLabel(run, item("failed_run:run:r2", { sourceKind: "failed_run" }))).toBe("Also failed");
    // PAP-768: a hard stop's Raise limit / Keep paused answer its override approval.
    const stop = item("budget_alert:budget:p1", { sourceKind: "budget_alert" });
    expect(attentionEvidenceLabel(stop, item("approval:approval:b1"))).toBe("Approval this answers");
    expect(attentionEvidenceText(review)).toEqual({
      title: "PAP-7 Ship the page",
      detail: "Issue is in review with a linked pending approval.",
    });
  });
});

describe("attentionEvidenceToShow", () => {
  const blocker = (id: string, subjectId: string, detail: Record<string, unknown>) => item(id, {
    sourceKind: "blocker_attention",
    subject: { kind: "issue", id: subjectId, companyId: "c1", title: "Task", identifier: null, status: null, href: null },
    detail: { kind: "blocker", blockingIssue: null, images: [], ...detail },
  } as Partial<AttentionItem>);

  it("drops a stalled-chain card for the same task under a human unblock card", () => {
    const lead = blocker("owner", "t1", { unblockAction: "Approve the plan" });
    const sameTask = blocker("stall", "t1", { blockedTaskCount: 2 });
    const otherTask = blocker("other", "t2", { blockedTaskCount: 1 });
    expect(attentionEvidenceToShow(lead, [sameTask, otherTask]).map((entry) => entry.id)).toEqual(["other"]);
  });

  it("keeps all evidence under any other card", () => {
    const lead = blocker("stall-lead", "t1", { blockedTaskCount: 2 });
    const sameTask = blocker("stall", "t1", { blockedTaskCount: 2 });
    expect(attentionEvidenceToShow(lead, [sameTask]).map((entry) => entry.id)).toEqual(["stall"]);
  });
});

