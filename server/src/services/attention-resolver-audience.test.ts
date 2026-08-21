import { describe, expect, it } from "vitest";
import { interactionResolverAudience } from "./attention.js";

const AGENT_NAMES: Record<string, string> = {
  "agent-watchdog": "Watchdog",
  "agent-codex": "CodexCoder",
};

const agentName = (agentId: string) => AGENT_NAMES[agentId] ?? null;

function row(overrides: Record<string, unknown> = {}) {
  return {
    addresseeAgentId: null,
    createdByAgentId: "agent-watchdog",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    ...overrides,
  } as Parameters<typeof interactionResolverAudience>[0];
}

describe("attention feed resolver audience", () => {
  it("carries the open default with the creator named", () => {
    expect(interactionResolverAudience(row(), agentName)).toEqual({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      effectiveResolverPolicySource: "requested",
      resolverPolicyProvenance: "inherited",
      addresseeAgentId: null,
      addresseeName: null,
      createdByAgentId: "agent-watchdog",
      createdByAgentName: "Watchdog",
    });
  });

  it("names the addressed agent", () => {
    expect(interactionResolverAudience(row({ addresseeAgentId: "agent-codex" }), agentName))
      .toMatchObject({ addresseeAgentId: "agent-codex", addresseeName: "CodexCoder" });
  });

  it("reports the company cap that narrowed the requested audience", () => {
    expect(interactionResolverAudience(
      row({
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "human_only",
        effectiveResolverPolicySource: "company_cap",
      }),
      agentName,
    )).toMatchObject({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "company_cap",
    });
  });

  it("keeps a pre-migration board_or_agents row restricted, matching the evaluator", () => {
    // The queue must not read `Anyone` while the resolution routes still treat
    // the card as creator-excluded.
    expect(interactionResolverAudience(
      row({
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_or_agents",
        resolverPolicyProvenance: "legacy_inherited_restriction",
      }),
      agentName,
    )).toMatchObject({
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
      resolverPolicyProvenance: "legacy_inherited_restriction",
    });
  });

  it("infers legacy provenance for a row written before the column existed", () => {
    expect(interactionResolverAudience(
      row({
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
        resolverPolicyProvenance: null,
        effectiveResolverPolicySource: null,
      }),
      agentName,
    )).toMatchObject({
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "legacy_inherited_restriction",
      effectiveResolverPolicySource: "requested",
    });
  });

  it("leaves an unknown agent unnamed rather than inventing a responder", () => {
    expect(interactionResolverAudience(
      row({ addresseeAgentId: "agent-deleted", createdByAgentId: null }),
      agentName,
    )).toMatchObject({
      addresseeName: null,
      createdByAgentId: null,
      createdByAgentName: null,
    });
  });
});
