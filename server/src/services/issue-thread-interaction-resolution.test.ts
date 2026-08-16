import { describe, expect, it } from "vitest";
import {
  evaluateIssueThreadInteractionResolverAudience,
  issueThreadInteractionAttentionAgentAllowed,
} from "./issue-thread-interaction-resolution.js";

const agent = { type: "agent", agentId: "agent-1", runId: "run-1" } as const;

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    createdByAgentId: "agent-1",
    createdByUserId: null,
    sourceRunId: "run-1",
    addresseeAgentId: null,
    effectiveResolverPolicy: "anyone",
    ...overrides,
  };
}

describe("issue-thread interaction resolver audience", () => {
  it.each([
    "suggest_tasks",
    "ask_user_questions",
    "request_confirmation",
    "request_checkbox_confirmation",
    "request_item_verdicts",
  ])("allows the creator and creating run under anyone for %s", () => {
    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction(),
    })).toMatchObject({ allowed: true, effectiveResolverPolicy: "anyone", reason: "allow_anyone" });
  });

  it.each([
    ["creator agent", { createdByAgentId: "agent-1", sourceRunId: "run-other" }],
    ["creating run", { createdByAgentId: "agent-other", sourceRunId: "run-1" }],
  ])("excludes the %s only when not_creator is effective", (_name, creator) => {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction({ ...creator, effectiveResolverPolicy: "not_creator" }),
    });
    expect(decision).toMatchObject({ allowed: false, code: "interaction_creator_excluded" });
  });

  it("enforces an explicit addressee", () => {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction({ addresseeAgentId: "agent-2" }),
    });
    expect(decision).toMatchObject({ allowed: false, code: "interaction_addressee_mismatch" });
  });

  it("requires run attribution for agents", () => {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "agent", agentId: "agent-1", runId: null },
      interaction: interaction(),
    });
    expect(decision).toMatchObject({
      allowed: false,
      status: 422,
      code: "interaction_run_attribution_required",
    });
  });

  it("allows a server-derived restriction to narrow but never widen the audience", () => {
    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction({ createdByAgentId: "agent-other", sourceRunId: "run-other" }),
      additionalRestriction: "human_only",
    })).toMatchObject({ allowed: false, code: "interaction_human_only" });

    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction({ effectiveResolverPolicy: "human_only" }),
      additionalRestriction: "anyone",
    })).toMatchObject({ allowed: false, code: "interaction_human_only" });
  });

  it("intersects human-only and creator-separation restrictions", () => {
    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "user", userId: "user-1" },
      interaction: interaction({
        createdByAgentId: null,
        createdByUserId: "user-1",
        effectiveResolverPolicy: "not_creator",
      }),
      additionalRestriction: "human_only",
    })).toMatchObject({ allowed: false, code: "interaction_creator_excluded" });

    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "user", userId: "user-1" },
      interaction: interaction({
        createdByAgentId: null,
        createdByUserId: "user-1",
        effectiveResolverPolicy: "human_only",
      }),
      additionalRestriction: "not_creator",
    })).toMatchObject({ allowed: false, code: "interaction_creator_excluded" });
  });

  it("excludes the review requester when a review card has null creator columns", () => {
    const restriction = {
      policy: "not_creator",
      excludedActor: { type: "user", id: "review-requester" },
      source: "issue_review",
    } as const;
    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "user", userId: "review-requester" },
      interaction: interaction({
        createdByAgentId: null,
        createdByUserId: null,
        sourceRunId: null,
      }),
      additionalRestriction: restriction,
    })).toMatchObject({
      allowed: false,
      code: "review_policy_denied",
      details: {
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      },
    });
    expect(evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "user", userId: "peer-reviewer" },
      interaction: interaction({
        createdByAgentId: null,
        createdByUserId: null,
        sourceRunId: null,
      }),
      additionalRestriction: restriction,
    })).toMatchObject({ allowed: true, effectiveResolverPolicy: "not_creator" });
  });

  it("keeps governed actions independently human-only", () => {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction(),
      governedAction: true,
    });
    expect(decision).toMatchObject({ allowed: false, code: "interaction_governed_action_denied" });
  });

  it("preserves legacy inherited board_or_agents creator separation", () => {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: agent,
      interaction: interaction({
        effectiveResolverPolicy: "board_or_agents",
        resolverPolicyProvenance: "legacy_inherited_restriction",
      }),
    });
    expect(decision).toMatchObject({ allowed: false, code: "interaction_creator_excluded" });
  });

  it("derives agent attention ownership from the same effective audience", () => {
    expect(issueThreadInteractionAttentionAgentAllowed({
      agentId: "agent-1",
      interaction: interaction(),
    })).toBe(true);
    expect(issueThreadInteractionAttentionAgentAllowed({
      agentId: "agent-1",
      interaction: interaction({ effectiveResolverPolicy: "not_creator" }),
    })).toBe(false);
    expect(issueThreadInteractionAttentionAgentAllowed({
      agentId: "agent-2",
      interaction: interaction({ effectiveResolverPolicy: "human_only" }),
    })).toBe(false);
  });
});
