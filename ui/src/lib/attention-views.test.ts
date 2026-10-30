import { describe, expect, it } from "vitest";
import type { AttentionAudience, AttentionItem, AttentionReceipt, AttentionSourceKind } from "@paperclipai/shared";
import {
  ATTENTION_COMPANY_AUDIENCE_TEXT,
  ATTENTION_POOL_AUDIENCE_TEXT,
  attentionItemClaimable,
  attentionReceiptLine,
  describeAttentionAudience,
  parseAttentionView,
  unassignedBannerText,
} from "./attention-views";
import { coordinatorAttentionQueryKey } from "./coordinator-attention";

function item(audience: AttentionAudience, sourceKind: AttentionSourceKind = "issue_thread_interaction") {
  return { id: "card", sourceKind, audience, subject: { id: "card" } } as unknown as AttentionItem;
}

describe("attention views (PAP-749 task 1b)", () => {
  it("defaults to For you and keeps only the three known views", () => {
    expect(parseAttentionView(null)).toBe("mine");
    expect(parseAttentionView("all")).toBe("mine");
    expect(parseAttentionView("bogus")).toBe("mine");
    expect(parseAttentionView("unassigned")).toBe("unassigned");
    expect(parseAttentionView("company")).toBe("company");
  });

  it("keys each list by company, person and view", () => {
    expect(coordinatorAttentionQueryKey("c1", "scott", "mine")).not.toEqual(coordinatorAttentionQueryKey("c1", "dotta", "mine"));
    expect(coordinatorAttentionQueryKey("c1", "scott", "mine")).not.toEqual(coordinatorAttentionQueryKey("c1", "scott", "unassigned"));
    expect(coordinatorAttentionQueryKey("c1", "scott", "mine").slice(0, 4)).toEqual(["attention", "c1", "scott", "mine"]);
  });

  it("answers Why me? for your own card from the audience reason", () => {
    expect(describeAttentionAudience(item({ kind: "user", userId: "scott", reason: "addressee" }), "scott"))
      .toEqual({ kind: "mine", text: "Sent to you" });
    expect(describeAttentionAudience(item({ kind: "user", userId: "scott", reason: "reviewer" }), "scott"))
      .toEqual({ kind: "mine", text: "You are the reviewer" });
    expect(describeAttentionAudience(item({ kind: "user", userId: "scott", reason: "instigator" }), "scott"))
      .toEqual({ kind: "mine", text: "You created the original task" });
    expect(describeAttentionAudience(item({ kind: "user", userId: "scott", reason: "escalation_owner" }), "scott"))
      .toEqual({ kind: "mine", text: "You are the default decision owner" });
  });

  it("names the project and budget escalation owners (PAP-749 task 1d)", () => {
    expect(describeAttentionAudience(item({ kind: "user", userId: "riley", reason: "project_owner" }), "riley"))
      .toEqual({ kind: "mine", text: "You own this project's decisions" });
    const budgetStop = item({ kind: "user", userId: "scott", reason: "budget_owner", alsoInCompany: true }, "budget_alert");
    expect(describeAttentionAudience(budgetStop, "scott")).toEqual({ kind: "mine", text: "You own budget escalation" });
    // Company still shows the hard stop to everyone else, as "For @scott".
    expect(describeAttentionAudience(budgetStop, "dotta")).toEqual({ kind: "other", userId: "scott" });
    expect(attentionItemClaimable(budgetStop)).toBe(false);
  });

  it("names the other person on a card that is not yours", () => {
    expect(describeAttentionAudience(item({ kind: "user", userId: "dotta", reason: "addressee" }), "scott"))
      .toEqual({ kind: "other", userId: "dotta" });
  });

  it("says why an ownerless card is answerable and offers Claim only where an addressee can be stored", () => {
    expect(describeAttentionAudience(item({ kind: "pool", userId: null, reason: "none" }), "scott"))
      .toEqual({ kind: "pool", text: ATTENTION_POOL_AUDIENCE_TEXT, claimable: true });
    expect(describeAttentionAudience(item({ kind: "pool", userId: null, reason: "none" }, "decision"), "scott"))
      .toEqual({ kind: "pool", text: ATTENTION_POOL_AUDIENCE_TEXT, claimable: false });
    // An ownerless interaction that moved to Company after 7 days can still be claimed.
    expect(describeAttentionAudience(item({ kind: "company", userId: null, reason: "none" }), "scott"))
      .toEqual({ kind: "company", text: ATTENTION_COMPANY_AUDIENCE_TEXT, claimable: true });
    expect(attentionItemClaimable(item({ kind: "company", userId: null, reason: "none" }, "failed_run"))).toBe(false);
    expect(attentionItemClaimable(item({ kind: "user", userId: "dotta", reason: "addressee" }))).toBe(false);
  });

  it("says \"Transferred by\" on a card routed to you (PAP-749 plan §6)", () => {
    expect(describeAttentionAudience(item({ kind: "user", userId: "riley", reason: "addressee", transferredByUserId: "scott" }), "riley"))
      .toEqual({ kind: "mine", text: "Transferred by", transferredByUserId: "scott" });
  });

  it("phrases receipts with display names, never IDs", () => {
    const labels = new Map([["scott", "Scott"], ["riley", "Riley"]]);
    const receipt = (outcome: AttentionReceipt["outcome"], transferredToUserId: string | null = null) =>
      ({ outcome, actorUserId: "scott", transferredToUserId }) as AttentionReceipt;
    expect(attentionReceiptLine(receipt("answered"), labels)).toBe("Answered by @Scott");
    expect(attentionReceiptLine(receipt("withdrawn"), labels)).toBe("Withdrawn by @Scott");
    expect(attentionReceiptLine(receipt("transferred", "riley"), labels)).toBe("Transferred to @Riley by @Scott");
    expect(attentionReceiptLine(receipt("approved"), null)).toBe("Approved by @someone");
  });

  it("phrases the Unassigned banner", () => {
    expect(unassignedBannerText(1)).toBe("1 card needs an owner");
    expect(unassignedBannerText(3)).toBe("3 cards need an owner");
  });
});
