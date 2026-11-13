import { describe, expect, it } from "vitest";
import {
  readNativeReviewAssignmentContext,
  validateNativeReviewAssignmentFacts,
  type NativeReviewAssignmentFacts,
} from "./native-review-participant.js";

const ids = { nativeReviewInteractionId: "11111111-1111-4111-8111-111111111111", nativeReviewDecisionId: "22222222-2222-4222-8222-222222222222" };

function facts(overrides: object = {}): NativeReviewAssignmentFacts {
  const base: NativeReviewAssignmentFacts = {
    companyId: "11111111-1111-4111-8111-111111111111",
    issueId: "33333333-3333-4333-8333-333333333333",
    agentId: "55555555-5555-4555-8555-555555555555",
    issueStatus: "in_review",
    issueStatusVersion: 3,
    issueLastStatusDecisionId: ids.nativeReviewDecisionId,
    issueAssigneeAgentId: "worker-1",
    issueExecutionRunId: "review-run",
    interaction: {
      id: ids.nativeReviewInteractionId,
      companyId: "11111111-1111-4111-8111-111111111111", issueId: "33333333-3333-4333-8333-333333333333", kind: "request_confirmation" as const, status: "pending" as const,
      sourceRunId: "44444444-4444-4444-8444-444444444444", addresseeAgentId: "55555555-5555-4555-8555-555555555555", effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited", addresseeUserId: null, resolvedByAgentId: null, resolvedByRunId: null,
      payload: { version: 1, prompt: "review", target: { type: "custom", key: "native_completion_review", revisionId: ids.nativeReviewDecisionId } },
    },
    decision: { companyId: "11111111-1111-4111-8111-111111111111", issueId: "33333333-3333-4333-8333-333333333333", id: ids.nativeReviewDecisionId, runId: "44444444-4444-4444-8444-444444444444", applicationState: "applied", decisionJson: { projectedStatusVersion: 3 } },
    sourceRun: { companyId: "11111111-1111-4111-8111-111111111111", nativeIssueId: "33333333-3333-4333-8333-333333333333", id: "44444444-4444-4444-8444-444444444444", agentId: "worker-1" },
    agentInvokable: true,
    ...(overrides as Record<string, unknown>),
  };
  return Object.assign({}, base, overrides);
}

describe("native review participant", () => {
  it("requires the two distinct native context bindings", () => {
    expect(readNativeReviewAssignmentContext({ nativeReviewInteractionId: "i" })).toBeNull();
    expect(readNativeReviewAssignmentContext(ids)).toEqual(ids);
    expect(readNativeReviewAssignmentContext({ ...ids, nativeReviewDecisionId: "bad" })).toBeNull();
  });

  it("accepts an authoritative pending review", () => {
    expect(validateNativeReviewAssignmentFacts(facts())).toBe(true);
  });

  it.each([
    ["wrong company", { companyId: "other" }],
    ["wrong issue", { issueId: "other" }],
    ["wrong reviewer", { agentId: "worker-1" }],
    ["wrong revision", { interaction: { ...facts().interaction, payload: { ...(facts().interaction as any).payload, target: { type: "custom", key: "native_completion_review", revisionId: "old" } } } }],
    ["stale status", { issueStatusVersion: 2 }],
    ["changed report", { sourceRun: { ...facts().sourceRun, agentId: "other-worker" } }],
    ["self review", { sourceRun: { ...facts().sourceRun, agentId: "55555555-5555-4555-8555-555555555555" } }],
    ["non invokable", { agentInvokable: false }],
    ["uncommitted decision", { decision: { ...facts().decision, applicationState: "proposed" } }],
    ["human only", { interaction: { ...facts().interaction, effectiveResolverPolicy: "human_only" } }],
    ["governed tool action", { interaction: { ...facts().interaction, payload: { ...facts().interaction.payload, toolAction: { kind: "x" } } } }],
  ])("rejects %s", (_name, override) => {
    expect(validateNativeReviewAssignmentFacts(facts(override))).toBe(false);
  });

  it("allows only the run that resolved the review to finish a resolved card", () => {
    const base = facts({ interaction: { ...facts().interaction, status: "accepted", resolvedByAgentId: "55555555-5555-4555-8555-555555555555", resolvedByRunId: "review-run" }, issueStatus: "done" });
    expect(validateNativeReviewAssignmentFacts({ ...base, allowResolvedByRunId: "other-run" })).toBe(false);
    expect(validateNativeReviewAssignmentFacts({ ...base, allowResolvedByRunId: "review-run" })).toBe(true);
  });

  it.each([
    ["unrelated run", { id: "other-run" }],
    ["terminal run", { id: "review-run", status: "succeeded" }],
    ["wrong review binding", { id: "review-run", contextSnapshot: { ...ids, issueId: "other-issue" } }],
  ])("rejects %s as the acting reviewer run", (_name, override) => {
    const base = facts({
      actingRun: {
        id: "review-run",
        companyId: "11111111-1111-4111-8111-111111111111",
        agentId: "55555555-5555-4555-8555-555555555555",
        status: "running",
        nativeIssueId: "33333333-3333-4333-8333-333333333333",
        contextSnapshot: {
          issueId: "33333333-3333-4333-8333-333333333333",
          ...ids,
          sourceRunId: "44444444-4444-4444-8444-444444444444",
          revisionId: ids.nativeReviewDecisionId,
        },
      },
    });
    expect(validateNativeReviewAssignmentFacts({
      ...base,
      actingRun: { ...base.actingRun!, ...override },
    })).toBe(false);
    expect(validateNativeReviewAssignmentFacts(base)).toBe(true);
  });
});
