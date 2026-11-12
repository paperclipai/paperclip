import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { hasPendingNativeReviewSiblings, prepareNativeReviewRenewal } from "./native-review-renewal.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const decision: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "in_review", toStatus: "in_review",
  reasonCode: "governed_response_waiting", unblockDescriptor: null,
  effects: [{ kind: "create_interaction", gate: { kind: "interaction", id: "pending" } }],
};
const input = { companyId: "company", issueId: "issue", runId: "new-run", agentId: "owner",
  assigneeAgentId: "owner", responsibleUserId: "person", issueStatus: "in_review", decision };
const card = { id: "pending", sourceRunId: "old-run", status: "pending", addresseeAgentId: "second-reviewer",
  addresseeUserId: null, effectiveResolverPolicy: "anyone", payload: { prompt: "Review the output", target: { revisionId: "old-decision" } } };

function database(results: unknown[][]): Db {
  return { select: () => {
    const rows = results.shift() ?? [];
    const query: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "for", "limit", "orderBy"]) query[method] = () => query;
    query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return query;
  } } as unknown as Db;
}

describe("native completion review renewal", () => {
  it("holds partial acceptance but lets the last reviewer resume the owner", async () => {
    const accepted = { ...card, id: "11111111-1111-4111-8111-111111111111", status: "accepted" };
    const scope = { companyId: "company", issueId: "issue", agentId: "owner", interactionId: accepted.id };
    expect(await hasPendingNativeReviewSiblings(database([[{ interaction: accepted }], [{ id: "other" }]]), scope)).toBe(true);
    expect(await hasPendingNativeReviewSiblings(database([[{ interaction: accepted }], []]), scope)).toBe(false);
    expect(await hasPendingNativeReviewSiblings(database([[]]), scope)).toBe(false);
  });
  it("does not query UUID columns for synthetic recovery interaction identifiers", async () => {
    const db = { select: () => { throw new Error("unexpected database access"); } } as unknown as Db;
    expect(await hasPendingNativeReviewSiblings(db, { companyId: "company", issueId: "issue", agentId: "owner", interactionId: "superseded-confirmation" })).toBe(false);
  });
  it("requests all reviewers again, including a previously accepted verdict", async () => {
    const accepted = { ...card, id: "accepted", status: "accepted", addresseeAgentId: "first-reviewer" };
    const renewal = await prepareNativeReviewRenewal(database([[card], [{ id: "old-decision" }],
      [{ interaction: accepted }, { interaction: card }]]), input);
    expect(renewal?.decision.effects).toEqual([
      expect.objectContaining({ kind: "bind_reviewer", ownerAgentId: "first-reviewer", requestKey: "renew:accepted" }),
      expect.objectContaining({ kind: "bind_reviewer", ownerAgentId: "second-reviewer", requestKey: "renew:pending" }),
    ]);
    expect(renewal?.interactions).toEqual([accepted, card]);
  });
  it("retains a human-only resolver policy instead of restoring agent authority", async () => {
    const human = { ...card, effectiveResolverPolicy: "human_only" };
    const renewal = await prepareNativeReviewRenewal(database([[human], [{ id: "old-decision" }], [{ interaction: human }]]), input);
    expect(renewal?.decision.effects).toEqual([expect.objectContaining({ ownerAgentId: null, ownerUserId: "person" })]);
  });
  it("does not immediately wake the owner again while the renewed reviews are pending", async () => {
    const renewal = await prepareNativeReviewRenewal(database([[card], [{ id: "old-decision" }], [{ interaction: card }]]), {
      ...input, decision: { ...decision, effects: [...decision.effects, { kind: "notify_owner", agentId: "owner", reason: "governed_gate_pending" }] },
    });
    expect(renewal?.decision.effects).toEqual([expect.objectContaining({ kind: "bind_reviewer" })]);
  });
  it.each([{ agentId: "other-owner" }, { issueStatus: "done" }])("does not renew without current owner authority: %j", async change => {
    expect(await prepareNativeReviewRenewal(database([]), { ...input, ...change })).toBeNull();
  });
  it("does not renew a card created by the current run", async () => {
    expect(await prepareNativeReviewRenewal(database([[{ ...card, sourceRunId: input.runId }]]), input)).toBeNull();
  });
  it("requires an applied source decision and a materialized review effect", async () => {
    expect(await prepareNativeReviewRenewal(database([[card], []]), input)).toBeNull();
    expect(await prepareNativeReviewRenewal(database([[card], [{ id: "old-decision" }], []]), input)).toBeNull();
  });
});
