import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionResolverAudience } from "@paperclipai/shared";
import type { RequestConfirmationInteraction } from "./issue-thread-interactions";
import {
  DEFAULT_RESOLVER_POLICY,
  RESOLVER_POLICY_CHOICES,
  describeAttentionResolverAudience,
  describeInteractionAudience,
  resolverPolicyEffect,
  resolverPolicyLabel,
} from "./interaction-audience";

function confirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "interaction-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-creator",
    createdByUserId: null,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
    payload: { version: 1, prompt: "Ship it?" },
    result: null,
    // Open default with inherited provenance — what an omitted `resolverPolicy`
    // produces under the PAP-17277 contract.
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_or_agents", effective: "board_or_agents" },
    ...overrides,
  };
}

describe("resolver policy vocabulary", () => {
  it("defaults to the open audience", () => {
    expect(DEFAULT_RESOLVER_POLICY).toBe("anyone");
    expect(RESOLVER_POLICY_CHOICES[0]).toMatchObject({ value: "anyone", isDefault: true });
    expect(RESOLVER_POLICY_CHOICES.map((choice) => choice.value)).toEqual([
      "anyone",
      "not_creator",
      "human_only",
    ]);
    expect(RESOLVER_POLICY_CHOICES.filter((choice) => choice.isDefault)).toHaveLength(1);
  });

  it("labels each canonical policy in plain language", () => {
    expect(resolverPolicyLabel("anyone")).toBe("Anyone");
    expect(resolverPolicyLabel("not_creator")).toBe("Anyone except creator");
    expect(resolverPolicyLabel("human_only")).toBe("Human only");
  });

  it("maps deprecated board aliases onto canonical copy", () => {
    expect(resolverPolicyLabel("board_or_agents")).toBe("Anyone");
    expect(resolverPolicyLabel("board_only")).toBe("Human only");
    expect(resolverPolicyEffect("board_only")).toBe(resolverPolicyEffect("human_only"));
  });

  it("previews an effect for every choice without naming a raw policy value", () => {
    for (const choice of RESOLVER_POLICY_CHOICES) {
      expect(choice.effect.length).toBeGreaterThan(0);
      expect(choice.effect).not.toContain(choice.value);
    }
  });
});

describe("describeInteractionAudience", () => {
  it("reads an omitted policy as open company attention", () => {
    const audience = describeInteractionAudience({ interaction: confirmation() });
    expect(audience.policy).toBe("anyone");
    expect(audience.isOpen).toBe(true);
    expect(audience.label).toBe("Anyone");
    expect(audience.narrowedBy).toBeNull();
    expect(audience.narrowedNote).toBeNull();
    expect(audience.summary).toBe(
      "Anyone in the organization can respond — the board or any agent, including the one that asked.",
    );
  });

  it("does not present an open card as board-required", () => {
    const audience = describeInteractionAudience({ interaction: confirmation() });
    expect(audience.summary).not.toMatch(/only .*board/i);
    expect(audience.summary).toMatch(/anyone in the organization/i);
  });

  it("names the excluded creator for an explicit not_creator restriction", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "not_creator",
        effectiveResolverPolicy: "not_creator",
        resolverPolicyProvenance: "explicit",
        legacyResolverPolicyAliases: { requested: null, effective: null },
      }),
      creatorLabel: "ClaudeCoder",
    });
    expect(audience.isOpen).toBe(false);
    expect(audience.label).toBe("Anyone except creator");
    expect(audience.narrowedBy).toBe("requested");
    expect(audience.summary).toBe("Anyone in the organization except ClaudeCoder can respond.");
    // An explicitly requested restriction needs no extra explanation.
    expect(audience.narrowedNote).toBeNull();
  });

  /**
   * PAP-17859, caught by rendering the card rather than reading it:
   * `formatAssigneeUserLabel` returns the display-cased "You" for the signed-in
   * reader, which is correct in a badge and wrong inside a sentence.
   */
  it("lowercases a self-referring label inside the summary sentence", () => {
    const addressed = describeInteractionAudience({
      interaction: confirmation({ addresseeUserId: "user-me" }),
      addresseeLabel: "You",
    });
    expect(addressed.summary).toBe("Only you can respond.");
    expect(addressed.shortSummary).toBe("Only you can respond");

    const excluded = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "not_creator",
        effectiveResolverPolicy: "not_creator",
        resolverPolicyProvenance: "explicit",
      }),
      creatorLabel: "You",
    });
    expect(excluded.summary).toBe("Anyone in the organization except you can respond.");
  });

  it("falls back to a generic creator phrase when the creator label is unknown", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "not_creator",
        effectiveResolverPolicy: "not_creator",
        resolverPolicyProvenance: "explicit",
      }),
    });
    expect(audience.summary).toBe(
      "Anyone in the organization except the agent that created it can respond.",
    );
  });

  it("keeps human-only ownership copy explicit", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
      }),
    });
    expect(audience.label).toBe("Human only");
    expect(audience.isOpen).toBe(false);
    expect(audience.summary).toBe(
      "Only a person on the board can respond — agents cannot resolve this card.",
    );
  });

  it("keeps addressee ownership copy when a named agent owns the card", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({ addresseeAgentId: "agent-release" }),
      addresseeLabel: "ReleaseBot",
    });
    expect(audience.isOpen).toBe(false);
    expect(audience.narrowedBy).toBe("addressee");
    expect(audience.summary).toBe("Only ReleaseBot or a person on the board can respond.");
    // The label must not claim "Anyone" next to a sentence naming one agent.
    expect(audience.label).toBe("Addressed");
  });

  it("keeps named ownership visible while human_only controls authorization", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        addresseeAgentId: "agent-release",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
      }),
      addresseeLabel: "ReleaseBot",
    });
    expect(audience.summary).toBe(
      "Assigned to ReleaseBot. Only a person on the board can respond — agents cannot resolve this card.",
    );
    expect(audience.shortSummary).toBe("Assigned to ReleaseBot · board only");
    expect(audience.label).toBe("Human only");
  });

  it("names one addressed user instead of the whole board", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        addresseeUserId: "user-alice",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
      }),
      addresseeLabel: "Alice",
    });
    expect(audience.summary).toBe("Only Alice can respond.");
    expect(audience.shortSummary).toBe("Only Alice can respond");
    expect(audience.label).toBe("Addressed");
  });

  it("explains a governed-action clamp", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "human_only",
        effectiveResolverPolicySource: "governed_action",
      }),
    });
    expect(audience.policy).toBe("human_only");
    expect(audience.requestedPolicy).toBe("anyone");
    expect(audience.narrowedBy).toBe("governed_action");
    expect(audience.narrowedNote).toBe(
      "This card runs a governed action, so it stays human-only whatever audience was requested.",
    );
  });

  it("explains a company cap using both audience labels", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "human_only",
        effectiveResolverPolicySource: "company_cap",
      }),
    });
    expect(audience.narrowedBy).toBe("company_cap");
    expect(audience.narrowedNote).toBe(
      "Organization interaction governance narrowed this from Anyone to Human only.",
    );
  });

  it("explains a legacy restricted card that predates the open default", () => {
    const audience = describeInteractionAudience({
      interaction: confirmation({
        requestedResolverPolicy: "not_creator",
        effectiveResolverPolicy: "not_creator",
        resolverPolicyProvenance: "legacy_inherited_restriction",
      }),
      creatorLabel: "ClaudeCoder",
    });
    expect(audience.narrowedBy).toBe("legacy_restriction");
    expect(audience.narrowedNote).toBe(
      "Created before Anyone became the default, so it stays restricted. A new card would be open.",
    );
    expect(audience.summary).toBe("Anyone in the organization except ClaudeCoder can respond.");
  });
});

/** The `resolverAudience` metadata the attention feed ships with an interaction row. */
function attentionAudience(
  overrides: Partial<AttentionResolverAudience> = {},
): AttentionResolverAudience {
  return {
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    effectiveResolverPolicySource: "requested",
    resolverPolicyProvenance: "inherited",
    addresseeAgentId: null,
    addresseeName: null,
    createdByAgentId: "agent-creator",
    createdByAgentName: "Watchdog",
    ...overrides,
  };
}

function attentionItem(
  audience: AttentionResolverAudience | null,
  sourceKind: AttentionItem["sourceKind"] = "issue_thread_interaction",
): Pick<AttentionItem, "sourceKind" | "resolverAudience"> {
  return { sourceKind, resolverAudience: audience };
}

describe("glanceable audience copy", () => {
  it("states the open default in one clause", () => {
    expect(describeInteractionAudience({ interaction: confirmation() }).shortSummary)
      .toBe("Anyone can respond");
  });

  it("names the excluded creator", () => {
    expect(describeInteractionAudience({
      interaction: confirmation({ requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator" }),
      creatorLabel: "Watchdog",
    }).shortSummary).toBe("Anyone except Watchdog can respond");
  });

  it("names the addressed responder", () => {
    expect(describeInteractionAudience({
      interaction: confirmation({ addresseeAgentId: "agent-codex" }),
      addresseeLabel: "CodexCoder",
    }).shortSummary).toBe("Only CodexCoder or the board can respond");
  });

  it("keeps human-only ownership with the board", () => {
    expect(describeInteractionAudience({
      interaction: confirmation({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only" }),
    }).shortSummary).toBe("Only the board can respond");
  });
});

describe("describeAttentionResolverAudience", () => {
  it("describes an open interaction row from server metadata alone", () => {
    const audience = describeAttentionResolverAudience(attentionItem(attentionAudience()));
    expect(audience?.policy).toBe("anyone");
    expect(audience?.isOpen).toBe(true);
    expect(audience?.label).toBe("Anyone");
    expect(audience?.shortSummary).toBe("Anyone can respond");
  });

  it("names the addressed agent the server recorded", () => {
    const audience = describeAttentionResolverAudience(attentionItem(attentionAudience({
      addresseeAgentId: "agent-codex",
      addresseeName: "CodexCoder",
    })));
    expect(audience?.label).toBe("Addressed");
    expect(audience?.shortSummary).toBe("Only CodexCoder or the board can respond");
  });

  it("names the excluded creator the server recorded", () => {
    const audience = describeAttentionResolverAudience(attentionItem(attentionAudience({
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
    })));
    expect(audience?.shortSummary).toBe("Anyone except Watchdog can respond");
  });

  it("carries the narrowing explanation for a company cap", () => {
    const audience = describeAttentionResolverAudience(attentionItem(attentionAudience({
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "company_cap",
    })));
    expect(audience?.narrowedBy).toBe("company_cap");
    expect(audience?.narrowedNote).toBe(
      "Organization interaction governance narrowed this from Anyone to Human only.",
    );
  });

  it("stays silent rather than guessing a policy client-side", () => {
    // No metadata (an older feed) and non-interaction rows must render nothing.
    expect(describeAttentionResolverAudience(attentionItem(null))).toBeNull();
    expect(describeAttentionResolverAudience({ sourceKind: "issue_thread_interaction" })).toBeNull();
    expect(describeAttentionResolverAudience(attentionItem(attentionAudience(), "approval"))).toBeNull();
  });
});
