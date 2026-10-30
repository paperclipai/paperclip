import { describe, expect, it } from "vitest";
import {
  audienceMatchesView,
  resolveAttentionAudience,
  type AttentionAudienceInput,
  type IssueAudienceContext,
} from "./attention.js";

const EMPTY_CTX: IssueAudienceContext = {
  conversationUserId: null,
  assigneeUserId: null,
  instigatorUserId: null,
};

function input(overrides: Partial<AttentionAudienceInput> = {}): AttentionAudienceInput {
  return { issueId: "issue-1", ...overrides };
}

function ctx(overrides: Partial<IssueAudienceContext> = {}): IssueAudienceContext {
  return { ...EMPTY_CTX, ...overrides };
}

describe("resolveAttentionAudience — audience steps (PAP-749 plan §1, Rule 2)", () => {
  it("routes an explicit user addressee to that user (step 1)", () => {
    expect(resolveAttentionAudience(input({ addresseeUserId: "scott" }), ctx({ instigatorUserId: "dotta" })))
      .toEqual({ kind: "user", userId: "scott", reason: "addressee" });
  });

  it("routes an approval to its requester", () => {
    expect(resolveAttentionAudience(input({ requestedByUserId: "scott" }), null))
      .toEqual({ kind: "user", userId: "scott", reason: "requester" });
  });

  it("routes a blocker/recovery card to its named user owner", () => {
    expect(resolveAttentionAudience(input({ ownerUserId: "scott" }), null))
      .toEqual({ kind: "user", userId: "scott", reason: "assignee" });
  });

  it("routes a chat card to the conversation user (step 2)", () => {
    expect(resolveAttentionAudience(input(), ctx({ conversationUserId: "scott" })))
      .toEqual({ kind: "user", userId: "scott", reason: "conversation" });
  });

  it("routes a review to its current human participant (step 3)", () => {
    expect(resolveAttentionAudience(input({ reviewParticipantUserId: "scott" }), ctx({ assigneeUserId: "dotta" })))
      .toEqual({ kind: "user", userId: "scott", reason: "reviewer" });
  });

  it("routes to the human assignee when no participant is named (step 3)", () => {
    expect(resolveAttentionAudience(input(), ctx({ assigneeUserId: "scott" })))
      .toEqual({ kind: "user", userId: "scott", reason: "assignee" });
  });

  it("routes to the instigator of the originating human work (step 4)", () => {
    expect(resolveAttentionAudience(input(), ctx({ instigatorUserId: "scott" })))
      .toEqual({ kind: "user", userId: "scott", reason: "instigator" });
  });

  it("sends company-operations alerts to the Company view", () => {
    expect(resolveAttentionAudience(input({ issueId: null, companyScoped: true }), null))
      .toEqual({ kind: "company", userId: null, reason: "none" });
  });

  it("sends a card with no owner to the claimable Unassigned pool (step 6)", () => {
    expect(resolveAttentionAudience(input(), EMPTY_CTX))
      .toEqual({ kind: "pool", userId: null, reason: "none" });
  });
});

describe("resolveAttentionAudience — precedence", () => {
  it("an explicit addressee beats every chain signal", () => {
    expect(resolveAttentionAudience(
      input({ addresseeUserId: "scott", requestedByUserId: "dotta", reviewParticipantUserId: "riley" }),
      ctx({ conversationUserId: "dotta", assigneeUserId: "riley", instigatorUserId: "dotta" }),
    )).toMatchObject({ userId: "scott", reason: "addressee" });
  });

  it("the conversation user beats a reviewer, assignee, and instigator", () => {
    expect(resolveAttentionAudience(
      input({ reviewParticipantUserId: "riley" }),
      ctx({ conversationUserId: "scott", assigneeUserId: "riley", instigatorUserId: "dotta" }),
    )).toMatchObject({ userId: "scott", reason: "conversation" });
  });

  it("a reviewer beats the assignee and the instigator", () => {
    expect(resolveAttentionAudience(
      input({ reviewParticipantUserId: "scott" }),
      ctx({ assigneeUserId: "riley", instigatorUserId: "dotta" }),
    )).toMatchObject({ userId: "scott", reason: "reviewer" });
  });

  it("the assignee beats the instigator", () => {
    expect(resolveAttentionAudience(
      input(),
      ctx({ assigneeUserId: "scott", instigatorUserId: "dotta" }),
    )).toMatchObject({ userId: "scott", reason: "assignee" });
  });
});

describe("resolveAttentionAudience — forbidden routing signals", () => {
  // `responsibleUserId`, the routine creator, the connected account, the agent
  // owner, and a manual routine starter are deliberately not inputs, so a card
  // whose only human signal would be one of them resolves to Unassigned, never
  // to a person (PAP-749 plan §1, Rule 2).
  it("does not route a card that has no addressee/owner/participant/instigator", () => {
    expect(resolveAttentionAudience(input(), EMPTY_CTX))
      .toEqual({ kind: "pool", userId: null, reason: "none" });
  });

  it("ignores a falsy owner/addressee rather than inventing a user", () => {
    expect(resolveAttentionAudience(
      input({ addresseeUserId: null, requestedByUserId: null, ownerUserId: null }),
      EMPTY_CTX,
    )).toEqual({ kind: "pool", userId: null, reason: "none" });
  });
});

describe("audienceMatchesView (PAP-749 plan §1, Rule 3)", () => {
  const userAudience = { kind: "user" as const, userId: "scott", reason: "addressee" as const };
  const otherUserAudience = { kind: "user" as const, userId: "dotta", reason: "instigator" as const };
  const poolAudience = { kind: "pool" as const, userId: null, reason: "none" as const };
  const companyAudience = { kind: "company" as const, userId: null, reason: "none" as const };

  it("`all` keeps every audience (the pre-PAP-749 superset)", () => {
    for (const audience of [userAudience, otherUserAudience, poolAudience, companyAudience]) {
      expect(audienceMatchesView(audience, "all", "scott")).toBe(true);
    }
  });

  it("`mine` keeps only the requesting user's cards", () => {
    expect(audienceMatchesView(userAudience, "mine", "scott")).toBe(true);
    expect(audienceMatchesView(otherUserAudience, "mine", "scott")).toBe(false);
    expect(audienceMatchesView(poolAudience, "mine", "scott")).toBe(false);
    expect(audienceMatchesView(companyAudience, "mine", "scott")).toBe(false);
  });

  it("`mine` keeps nothing when the requesting user is unknown", () => {
    expect(audienceMatchesView(userAudience, "mine", null)).toBe(false);
  });

  it("`unassigned` keeps only pool cards", () => {
    expect(audienceMatchesView(poolAudience, "unassigned", "scott")).toBe(true);
    expect(audienceMatchesView(userAudience, "unassigned", "scott")).toBe(false);
    expect(audienceMatchesView(companyAudience, "unassigned", "scott")).toBe(false);
  });

  it("`company` keeps only company-operations cards", () => {
    expect(audienceMatchesView(companyAudience, "company", "scott")).toBe(true);
    expect(audienceMatchesView(poolAudience, "company", "scott")).toBe(false);
    expect(audienceMatchesView(userAudience, "company", "scott")).toBe(false);
  });
});
