import { describe, expect, it } from "vitest";
import { planReviewIdentityCases } from "./identity-plan-review.js";
import type { IdentityObservation, Interaction } from "./identity-support.js";
function valid(scenarioId: string): IdentityObservation {
  const review = scenarioId.endsWith("review-plan");
  const original = { id: "proposal", kind: "request_confirmation", status: "pending", payload: { target: { revisionId: "reviewed" } } };
  const task = { id: "task", companyId: "acorn", title: "Acorn research launch", description: "Acorn research launch", assigneeAgentId: "morgan", status: "in_progress" };
  const current = { ...original, status: review ? "accepted" : "rejected", resolvedByAgentId: "ceo", result: { commentId: "canonical" } } as unknown as Interaction;
  const o: IdentityObservation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], interactions: [current], tasks: [task], projects: [], goals: [], comments: [], documents: [], revisions: [],
    activity: [{ id: "created", action: "issue.created", entityId: "task", agentId: "ceo" }], links: ["/ACO/issues/task"], reply: review ? "The reviewed plan is approved; Morgan is starting the task." : "The publication was declined. Review the local draft.", humanQueries: [],
    runs: [{ id: "lead-run", agentId: "ceo", companyId: "acorn", status: "succeeded", runtimeMode: "native", startedAt: "2026-11-03T00:00:01Z", contextSnapshot: { issueId: "chat", commentId: "canonical" } }, { id: "worker-run", agentId: "morgan", companyId: "acorn", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "task" } }],
    state: { original, plan: { id: "plan", latestRevisionId: "reviewed" }, sourcePlanRevisionAfter: "reviewed", sourceId: "chat", personId: "person", planDecisionComments: [{ id: "canonical", authorAgentId: null, authorUserId: "person", createdAt: "2026-11-03T00:00:00Z", matchesQuery: true, bodyPresent: true }], worker: { id: "morgan" }, scopeMarker: "Acorn research launch", sourceRetainsConversation: true, canonicalCommentId: "canonical",
      staleAttemptStatus: 409, staleErrorCode: "interaction_stale_target", newerRevisionVisible: true, newerRevisionId: "new", staleRevisionId: "old", staleExpired: true, rejectedReceiptVisible: true, noPublishedWorkProduct: true } };
  if (review) o.activity.push({ id: "approved", action: "issue.thread_interaction_accepted", details: { interactionId: "proposal", responseCommentId: "canonical" } });
  else { o.documents.push({ id: "draft", issueId: "task", key: "plan", body: "# Acorn research launch — local draft for review", latestRevisionId: "draft-version" });
    o.revisions.push({ id: "draft-version", documentId: "draft", createdByRunId: "worker-run", createdByAgentId: "morgan" }); }
  return o;
}
describe("versioned approval and revised publication scope", () => {
  for (const d of planReviewIdentityCases) {
    it(`${d.scenarioId}: independent valid and missing evidence`, () => { const o = valid(d.scenarioId); expect(d.grade(o), JSON.stringify(d.grade(o))).toMatchObject({ passed: true }); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: changed target revision rejected`, () => { const o = valid(d.scenarioId); (o.state.plan as { latestRevisionId: string }).latestRevisionId = "unreviewed"; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: response promise without executed result rejected`, () => { const o = valid(d.scenarioId); o.runs = []; expect(d.grade(o).passed).toBe(false); });
  }
  it("accepts the approved scope in the actual execution task plan and rejects wrong document, revision or writer bindings", () => {
    const d = planReviewIdentityCases[0]!; const o = valid(d.scenarioId);
    o.tasks[0]!.title = "Prepare research checklist"; o.tasks[0]!.description = "See the saved execution plan.";
    o.documents = [{ id: "execution-plan", issueId: "task", key: "plan", body: "Acorn research launch. Approved source revision reviewed.", latestRevisionId: "handoff" }];
    o.revisions = [{ id: "handoff", documentId: "execution-plan", createdByRunId: "lead-run", createdByAgentId: "ceo" }];
    expect(d.grade(o).passed).toBe(true);
    o.documents[0]!.issueId = "unrelated-task"; expect(d.grade(o).passed).toBe(false); o.documents[0]!.issueId = "task";
    o.documents[0]!.body = "Acorn research launch. A different source revision."; expect(d.grade(o).passed).toBe(false);
    o.documents[0]!.body = "Acorn research launch. Approved source revision reviewed.";
    o.revisions[0]!.createdByRunId = "unrelated-run"; expect(d.grade(o).passed).toBe(false);
    o.revisions[0]!.createdByRunId = "lead-run"; o.links = []; expect(d.grade(o).passed).toBe(false);
  });
  it("rejects a still-pending publication proposal even when a correct local review draft exists", () => {
    const d = planReviewIdentityCases[1]!; const o = valid(d.scenarioId); o.interactions[0]!.status = "pending";
    expect(d.grade(o).passed).toBe(false);
  });
  it("rejects acceptance of a stale revision despite successful current work", () => { const d = planReviewIdentityCases[0]!; const o = valid(d.scenarioId); o.state.staleAttemptStatus = 200; expect(d.grade(o).passed).toBe(false); });
  it("rejects reusing approval on the publication after the draft request", () => { const d = planReviewIdentityCases[1]!; const o = valid(d.scenarioId); o.interactions[0]!.status = "accepted"; expect(d.grade(o).passed).toBe(false); });
  it("rejects a published work product while keeping a real local draft", () => { const d = planReviewIdentityCases[1]!; const o = valid(d.scenarioId); o.state.noPublishedWorkProduct = false; expect(d.grade(o).passed).toBe(false); });
  it("allows actual attributed local chat draft without unnecessarily requiring delegation", () => { const d = planReviewIdentityCases[1]!; const o = valid(d.scenarioId); o.tasks = []; o.runs = o.runs.filter(run => run.agentId === "ceo"); o.documents[0] = { ...o.documents[0]!, issueId: "chat" }; o.revisions[0] = { ...o.revisions[0]!, createdByRunId: "lead-run", createdByAgentId: "ceo" }; o.links = ["#document-plan"]; expect(d.grade(o).passed).toBe(true); o.links = []; expect(d.grade(o).passed).toBe(false); });
  it("rejects an otherwise real draft revision written by an unrelated run", () => { const d = planReviewIdentityCases[1]!; const o = valid(d.scenarioId); o.revisions[0]!.createdByRunId = "unrelated-run"; expect(d.grade(o).passed).toBe(false); });
});
