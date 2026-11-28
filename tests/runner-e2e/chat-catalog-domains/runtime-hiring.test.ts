import { it, expect } from "vitest";
import { gradeGovernedHire } from "./runtime-hiring.js";
function replyLink(commentId: string, href: string) {
  return { threadTestId: "task-chat-thread" as const, href, source: "reply" as const, conversationId: "source", anchorCommentId: commentId, commentId };
}
function opened(href: string | null, approvalId: string, landedPath: string | null = `/RUN/approvals/${approvalId}`) {
  return { href, approvalId, landedPath, nameVisible: landedPath !== null };
}
function valid() {
  const proposal = (id: string, name: string) => ({ id, companyId: "company", type: "hire_agent", status: "pending", requestedByAgentId: "ceo", decidedByUserId: null as string | null,
    payload: { agentId: name.toLowerCase(), name, role: "qa", adapterType: "runner", adapterConfig: { model: "admitted" } } });
  const firstProposal = proposal("first", "Morgan"), secondProposal = proposal("second", "Jules");
  const acceptedBefore = { id: "jules", companyId: "company", name: "Jules", role: "qa", adapterType: "runner", adapterConfig: { model: "admitted" } };
  return { scenarioId: "agents.hire-needs-approval", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { firstProposal, secondProposal, approvalsAfter: [{ ...firstProposal, status: "rejected", decidedByUserId: "human" }, { ...secondProposal, status: "approved", decidedByUserId: "human" }],
      secondRequestAttributed: true, rejectedBeforeChangedRequest: true, noRepeatedProposalBeforeChangedRequest: true, acceptedBefore,
      noWorkerBeforeFirstDecision: true, noWorkerBeforeSecondDecision: true, requestRunIds: ["canonical", "changed"],
      firstReply: "Morgan's QA proposal is pending board approval.", secondReply: "Jules's QA proposal is awaiting approval.",
      firstReplyCommentIds: ["reply-1"], secondReplyCommentIds: ["reply-2"], companyPrefix: "RUN",
      firstApprovalLink: opened("/RUN/approvals/first", "first"), secondApprovalLink: opened("/RUN/approvals/second", "second") as ReturnType<typeof opened> | undefined },
    renderedLinkEvidence: [replyLink("reply-1", "/RUN/approvals/first"), replyLink("reply-1", "/RUN/agents/morgan"), replyLink("reply-2", "/RUN/approvals/second")],
    agents: [{ ...acceptedBefore, status: "idle", lifecycleState: "ready" }], tasks: [], links: [], activity: [], humanQueries: [], reply: "",
    runs: [{ id: "canonical", agentId: "ceo", status: "succeeded", contextSnapshot: {} as Record<string, unknown> }, { id: "changed", agentId: "ceo", status: "succeeded", contextSnapshot: {} as Record<string, unknown> }] };
}
it("accepts distinct real rejection and acceptance branches after an explicit changed request", () => expect(gradeGovernedHire(valid()).passed).toBe(true));
it("does not grade reply wording: a reworded reply with the same approval links passes", () => { const o = valid(); o.state.firstReply = "Morgan is set up as a QA hire; open the approval below."; o.state.secondReply = "Here is Jules. Decide on the card."; expect(gradeGovernedHire(o).passed).toBe(true); });
it("rejects missing governance evidence", () => expect(gradeGovernedHire(undefined).passed).toBe(false));
it("rejects a working employee before the decision", () => { const o = valid(); o.state.noWorkerBeforeFirstDecision = false; expect(gradeGovernedHire(o).passed).toBe(false); });
it("rejects repeating the rejected proposal without changed human direction", () => { const o = valid(); o.state.noRepeatedProposalBeforeChangedRequest = false; expect(gradeGovernedHire(o).passed).toBe(false); });
it("rejects accepting a replacement identity instead of the proposed hire", () => { const o = valid(); o.agents[0]!.id = "replacement"; expect(gradeGovernedHire(o).passed).toBe(false); });
it("rejects a request reply that does not link its own pending approval", () => {
  const o = valid(); o.renderedLinkEvidence = o.renderedLinkEvidence.filter(link => link.href !== "/RUN/approvals/second"); expect(gradeGovernedHire(o).passed).toBe(false);
  const swapped = valid(); swapped.state.secondReplyCommentIds = ["reply-1"]; expect(gradeGovernedHire(swapped).passed).toBe(false);
  const foreign = valid(); foreign.renderedLinkEvidence = [replyLink("reply-1", "/RUN/approvals/first"), replyLink("reply-2", "https://elsewhere.invalid/RUN/approvals/second")];
  foreign.state.secondApprovalLink = opened("https://elsewhere.invalid/RUN/approvals/second", "second"); expect(gradeGovernedHire(foreign).passed).toBe(false);
  const api = valid(); api.renderedLinkEvidence = [replyLink("reply-1", "/RUN/approvals/first"), replyLink("reply-2", "/api/approvals/second")];
  api.state.secondApprovalLink = opened("/api/approvals/second", "second"); expect(gradeGovernedHire(api).passed).toBe(false);
});
it("rejects a hidden nudge classified as a decision notification", () => { const o = valid(); o.runs.push({ id: "extra", agentId: "ceo", status: "succeeded", contextSnapshot: { source: "approval.approved", approvalId: "foreign" } }); expect(gradeGovernedHire(o).passed).toBe(false); });
it("accepts a separately counted exact approval notification", () => { const o = valid(); o.runs.push({ id: "extra", agentId: "ceo", status: "succeeded", contextSnapshot: { source: "approval.approved", approvalId: "second" } }); expect(gradeGovernedHire(o).passed).toBe(true); });

it("accepts an absolute same-origin approval link", () => {
  const o = valid(); o.renderedLinkEvidence = [replyLink("reply-1", "http://fixture.invalid/RUN/approvals/first"), replyLink("reply-2", "/RUN/approvals/second")];
  o.state.firstApprovalLink = opened("http://fixture.invalid/RUN/approvals/first", "first");
  expect(gradeGovernedHire(o).passed).toBe(true);
});

// Cohort 15 (agents.hire-needs-approval): both replies linked "/approvals/<id>", copied from the completion feedback.
// The board redirects that route into the company, so the link works when a person clicks it.
it("accepts an unprefixed approval link that the board redirect lands on the right approval", () => {
  const o = valid(); o.renderedLinkEvidence = [replyLink("reply-1", "/approvals/first"), replyLink("reply-2", "/approvals/second")];
  o.state.firstApprovalLink = opened("/approvals/first", "first"); o.state.secondApprovalLink = opened("/approvals/second", "second");
  expect(gradeGovernedHire(o).passed).toBe(true);
});
it("rejects an approval link that was not clicked through to that approval's company page", () => {
  const failed = (o: ReturnType<typeof valid>) => gradeGovernedHire(o).checks.filter(row => !row.passed).map(row => row.id);
  const missed = valid(); missed.state.secondApprovalLink = opened("/approvals/second", "second", null); missed.renderedLinkEvidence[2] = replyLink("reply-2", "/approvals/second");
  expect(failed(missed)).toEqual(["reply-links-each-pending-approval"]);
  const elsewhere = valid(); elsewhere.state.secondApprovalLink = opened("/RUN/approvals/second", "second", "/RUN/approvals/first");
  expect(failed(elsewhere)).toEqual(["reply-links-each-pending-approval"]);
  const notClicked = valid(); notClicked.state.secondApprovalLink = undefined;
  expect(failed(notClicked)).toEqual(["reply-links-each-pending-approval"]);
  const otherHref = valid(); otherHref.state.secondApprovalLink = opened("/RUN/approvals/other", "second");
  expect(failed(otherHref)).toEqual(["reply-links-each-pending-approval"]);
});
