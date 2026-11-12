import { describe, expect, it } from "vitest";
import type { AttentionAudience, AttentionItem, AttentionReceipt, AttentionSourceKind } from "@paperclipai/shared";
import {
  ATTENTION_COMPANY_AUDIENCE_TEXT,
  ATTENTION_POOL_AUDIENCE_TEXT,
  attentionAudienceLineNamesResponders,
  attentionClaimAlternative,
  attentionEveryoneViewAllowed,
  attentionItemClaimable,
  attentionReceiptLine,
  attentionResponderText,
  attentionUnownedAudienceText,
  attentionViewsFor,
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

  it("opens Everyone only for a board member (PAP-768)", () => {
    expect(parseAttentionView("all", { everyone: true })).toBe("all");
    expect(parseAttentionView("all", { everyone: false })).toBe("mine");
    expect(attentionViewsFor(false)).toEqual(["mine", "unassigned", "company", "archived"]);
    expect(attentionViewsFor(true)).toEqual(["mine", "unassigned", "company", "archived", "all"]);
  });

  it("treats owners, admins, operators and legacy members as board members, not viewers (PAP-768)", () => {
    const member = (membershipRole: "owner" | "admin" | "operator" | "viewer" | "member" | null, status: "active" | "suspended" = "active") =>
      ({ source: "session", isInstanceAdmin: false, memberships: [{ companyId: "c1", membershipRole, status }] });
    for (const role of ["owner", "admin", "operator", "member"] as const) {
      expect(attentionEveryoneViewAllowed("c1", member(role))).toBe(true);
    }
    expect(attentionEveryoneViewAllowed("c1", member("viewer"))).toBe(false);
    expect(attentionEveryoneViewAllowed("c1", member(null))).toBe(false);
    expect(attentionEveryoneViewAllowed("c1", member("owner", "suspended"))).toBe(false);
    expect(attentionEveryoneViewAllowed("c2", member("owner"))).toBe(false);
    expect(attentionEveryoneViewAllowed("c1", { source: "local_implicit", isInstanceAdmin: false, memberships: [] })).toBe(true);
    expect(attentionEveryoneViewAllowed("c1", { source: "session", isInstanceAdmin: true, memberships: [] })).toBe(true);
    expect(attentionEveryoneViewAllowed("c1", undefined)).toBe(false);
    expect(attentionEveryoneViewAllowed(null, member("owner"))).toBe(false);
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

  it("says who may answer in the same statement as why the card is here (PAP-767)", () => {
    const resolver = (overrides: Partial<NonNullable<AttentionItem["resolverAudience"]>> = {}) => ({
      requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", effectiveResolverPolicySource: "requested",
      resolverPolicyProvenance: "inherited", addresseeAgentId: null, addresseeUserId: null, addresseeName: null,
      createdByAgentId: "agent-1", createdByAgentName: "Watchdog", ...overrides,
    }) as NonNullable<AttentionItem["resolverAudience"]>;
    const card = (audience: AttentionAudience, resolverAudience: AttentionItem["resolverAudience"]) =>
      ({ ...item(audience), resolverAudience }) as AttentionItem;
    const describe_ = (entry: AttentionItem, viewer: string) => describeAttentionAudience(entry, viewer)!;

    // NEE-15: the project owner's card is open to anyone, so others may answer it too.
    const owned = card({ kind: "user", userId: "dotta", reason: "project_owner" }, resolver());
    expect(attentionResponderText(owned, describe_(owned, "dotta"))).toBe("Anyone else can answer it too.");
    const sent = card({ kind: "user", userId: "dotta", reason: "addressee" }, resolver({ addresseeUserId: "dotta" }));
    expect(attentionResponderText(sent, describe_(sent, "dotta"))).toBe("Only you can answer it.");
    expect(attentionResponderText(sent, describe_(sent, "scott"), new Map([["dotta", "Dotta"]]))).toBe("Only @Dotta can answer it.");

    // An ownerless card addressed to a napping agent names the agent and the board, once.
    const napping = card({ kind: "pool", userId: null, reason: "none" }, resolver({ addresseeAgentId: "agent-2", addresseeName: "Napping Agent" }));
    const pool = describe_(napping, "scott") as Extract<ReturnType<typeof describeAttentionAudience>, { kind: "pool" }>;
    expect(attentionUnownedAudienceText(napping, pool)).toBe("No owner yet. Napping Agent or any board member can answer it.");
    const boardOnly = card({ kind: "pool", userId: null, reason: "none" }, resolver({ effectiveResolverPolicy: "human_only" }));
    expect(attentionUnownedAudienceText(boardOnly, pool)).toBe("No owner yet. Any board member can answer it.");
    const notCreator = card({ kind: "pool", userId: null, reason: "none" }, resolver({ effectiveResolverPolicy: "not_creator" }));
    expect(attentionUnownedAudienceText(notCreator, pool)).toBe("No owner yet. Anyone except Watchdog can answer it.");
    // A card with no resolver facts (an approval, a recovery) keeps the plain line.
    const approval = { ...item({ kind: "pool", userId: null, reason: "none" }, "approval"), resolverAudience: null } as AttentionItem;
    expect(attentionUnownedAudienceText(approval, pool)).toBe(ATTENTION_POOL_AUDIENCE_TEXT);
    expect(attentionAudienceLineNamesResponders(napping, "scott")).toBe(true);
    expect(attentionAudienceLineNamesResponders(napping, null)).toBe(false);
    expect(attentionAudienceLineNamesResponders(approval, "scott")).toBe(false);
  });

  it("offers the task instead of Claim on an ownerless card with no owner field (PAP-767)", () => {
    const pool: AttentionAudience = { kind: "pool", userId: null, reason: "none" };
    const withTask = { ...item(pool, "blocker_attention"), subject: { id: "i", kind: "issue", href: "/NEE/issues/NEE-16" } } as unknown as AttentionItem;
    expect(attentionClaimAlternative(withTask)).toEqual({ kind: "assign", href: "/NEE/issues/NEE-16" });
    const noTask = { ...item(pool, "approval"), relatedIssue: null } as AttentionItem;
    expect(attentionClaimAlternative(noTask)).toEqual({ kind: "none" });
    // Claim itself, a card for a person and a company alert need no alternative.
    expect(attentionClaimAlternative(item(pool))).toBeNull();
    expect(attentionClaimAlternative(item({ kind: "user", userId: "scott", reason: "addressee" }, "approval"))).toBeNull();
    expect(attentionClaimAlternative({ ...item({ kind: "company", userId: null, reason: "none" }, "failed_run"), stale: null } as AttentionItem)).toBeNull();
    const unowned = { ...item({ kind: "company", userId: null, reason: "none" }, "blocker_attention"), stale: { reason: "unowned" },
      subject: { id: "i", kind: "issue", href: "/NEE/issues/NEE-9" } } as unknown as AttentionItem;
    expect(attentionClaimAlternative(unowned)).toEqual({ kind: "assign", href: "/NEE/issues/NEE-9" });
  });

  it("phrases the Unassigned banner", () => {
    expect(unassignedBannerText(1)).toBe("1 card needs an owner");
    expect(unassignedBannerText(3)).toBe("3 cards need an owner");
  });
});
