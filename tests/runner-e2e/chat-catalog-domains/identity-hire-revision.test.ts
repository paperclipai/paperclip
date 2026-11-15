import { describe, expect, it } from "vitest";
import { proveHireModelChoice } from "./identity-hire-model-choice.js";
import { gradeHireRevision } from "./identity-hire-revision.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(): IdentityObservation {
  const models = ["openrouter/deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4.1-flash-1017"];
  const modelChoice = { ...proveHireModelChoice({ data: models.map((id, index) => ({ id: id.replace(/^openrouter\//, ""), pricing: { prompt: index ? "0.1" : "1", completion: index ? "0.2" : "2", input_cache_read: index ? "0.01" : "0.02" } })) }, models.map(id => ({ id }))), metadataSha256: "a".repeat(64), retrievedAt: "2026-10-28T00:00:00Z" };
  return { scenarioId: "questions-and-approvals.formal-hire-revision", origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [{ id: "ceo" }], tasks: [], projects: [], goals: [], interactions: [], comments: [], documents: [], revisions: [], links: [], runs: [], humanQueries: [], reply: "The proposal is back for board approval.",
    activity: [{ id: "revision", action: "approval.revision_requested", entityId: "approval", actorType: "user" }, { id: "resubmit", action: "approval.resubmitted", entityId: "approval", actorType: "agent", agentId: "ceo" }],
    state: { modelChoice, originalApproval: { id: "approval", payload: { adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4-pro" } } }, currentApproval: { id: "approval", companyId: "acorn", type: "hire_agent", requestedByAgentId: "ceo", status: "pending", decidedByUserId: null, decidedAt: null, payload: { adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" } } },
      originalModel: "openrouter/deepseek/deepseek-v4-pro", cheaperModel: "openrouter/deepseek/deepseek-v4.1-flash-1017", eligibleModels: ["openrouter/deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4.1-flash-1017"], originalOtherFieldsPreserved: true, humanId: "alex", originalHistoryCommentId: "history", beforeAgentCount: 1, pendingProposalVisible: true, revisedModelVisible: true,
      approvalComments: [{ id: "history", authorUserId: "alex", body: "Original openrouter/deepseek/deepseek-v4-pro, board selected openrouter/deepseek/deepseek-v4.1-flash-1017" }, { id: "revision-comment", authorAgentId: "ceo", body: "Revised to openrouter/deepseek/deepseek-v4.1-flash-1017 and resubmitted for approval." }] } };
}
function validChatRevision(): IdentityObservation {
  const o = valid(), query = "Change the proposed hire to the cheaper model and send it back for approval.";
  o.state.approvalComments = (o.state.approvalComments as unknown[]).slice(0, 1);
  o.state.sourceIssueId = "source";
  o.reply = "Updated the proposed hire to the cheaper model `openrouter/deepseek/deepseek-v4.1-flash-1017` (was `deepseek-v4-pro`) and resubmitted it. It's awaiting your review at [the pending approval](/approvals/approval) — it must be approved before the hire proceeds.";
  o.humanQueries = [query];
  o.runs = [{ id: "native", companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native", nativeIssueId: "source",
    resultJson: { finalizationPhase: "committed" }, contextSnapshot: { source: "issue.comment", issueId: "source", commentId: "human",
      paperclipWake: { comments: [{ id: "human", issueId: "source", body: query, author: { type: "user", id: "alex" } }] } } }];
  const comment = { id: "bound-reply", companyId: "acorn", issueId: "source", authorAgentId: "ceo", authorUserId: null, createdByRunId: "native", body: o.reply };
  o.comments = [structuredClone(comment)];
  o.state.revisionHistoryComment = structuredClone(comment);
  Object.assign(o.company, { issuePrefix: "ACORN" });
  o.renderedLinkEvidence = [{ threadTestId: "task-chat-thread", source: "reply", href: "/approvals/approval", conversationId: "source", anchorCommentId: "bound-reply", commentId: "bound-reply" }];
  o.state.revisionHistoryLink = structuredClone(o.renderedLinkEvidence[0]);
  return o;
}
describe("formal hire remains a proposal after cost revision", () => {
  it("accepts retained original history and the exact bound native revision reply without an extra approval comment", () => {
    expect(gradeHireRevision(validChatRevision()).passed).toBe(true);
  });
  it.each(["deepseek-v4.1-flash-1017", "openrouter/deepseek/deepseek-v4.1-flash-1017"])("resolves the exact displayed model identifier %s against the saved catalog", model => {
    const o = validChatRevision();
    const body = `Updated the proposed hire to \`${model}\` (was \`deepseek-v4-pro\`) and resubmitted it. The [pending approval](/approvals/approval) needs your review before the hire proceeds.`;
    o.reply = body;
    o.comments[0]!.body = body;
    (o.state.revisionHistoryComment as { body: string }).body = body;
    expect(gradeHireRevision(o).passed).toBe(true);
    for (const wrong of ["openrouter/deepseek/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash-1017:batch", "other/deepseek/deepseek-v4.1-flash-1017"]) {
      // A reply that names another catalog model as the revision states a wrong fact.
      const invalid = structuredClone(o), changed = body.replace(model, wrong);
      (invalid.state.eligibleModels as string[]).push(wrong);
      invalid.reply = changed;
      invalid.comments[0]!.body = changed;
      (invalid.state.revisionHistoryComment as { body: string }).body = changed;
      expect(gradeHireRevision(invalid).passed).toBe(false);
    }
    const noLink = structuredClone(o); noLink.renderedLinkEvidence = [];
    expect(gradeHireRevision(noLink).passed).toBe(false);
    const wrongProposal = structuredClone(o);
    (wrongProposal.state.currentApproval as { payload: { adapterConfig: { model: string } } }).payload.adapterConfig.model = "openrouter/deepseek/deepseek-v4.1-flash";
    expect(gradeHireRevision(wrongProposal).passed).toBe(false);
  });
  it.each([
    "The revised hire is pending your approval. Review [the pending approval](/ACORN/approvals/approval) — it must be approved before the hire can proceed.",
    "Done. [Open it](/approvals/approval).",
  ])("accepts a linked reply that does not repeat the model, with or without an approval note: %s", body => {
    // The saved proposal and the request behind the reply's link carry the revised model; wording is not graded.
    for (const withNote of [false, true]) {
      const o = validChatRevision();
      if (withNote) o.state.approvalComments = valid().state.approvalComments;
      o.reply = body;
      o.comments[0]!.body = body;
      (o.state.revisionHistoryComment as { body: string }).body = body;
      expect(gradeHireRevision(o).passed).toBe(true);
      const expensive = structuredClone(o);
      (expensive.state.currentApproval as { payload: { adapterConfig: { model: string } } }).payload.adapterConfig.model = "openrouter/deepseek/deepseek-v4-pro";
      expect(gradeHireRevision(expensive).passed).toBe(false);
      const unseen = structuredClone(o); unseen.state.revisedModelVisible = false;
      expect(gradeHireRevision(unseen).passed).toBe(false);
      const unlinked = structuredClone(o); unlinked.renderedLinkEvidence = [];
      expect(gradeHireRevision(unlinked).passed).toBe(withNote);
    }
  });
  it("accepts a bound revision reply alongside progress from the same run", () => {
    const o = validChatRevision();
    const progress = { ...structuredClone(o.comments[0]!), id: "progress", body: "I am checking the revised proposal." };
    o.comments.unshift(progress);
    o.reply = o.comments.map(row => row.body).join("\n\n");
    expect(gradeHireRevision(o).passed).toBe(true);
  });
  it("accepts an earlier bound revision note when the final message only asks for board review", () => {
    const o = validChatRevision();
    o.comments.push({ ...structuredClone(o.comments[0]!), id: "final", body: "It remains pending board approval." });
    o.reply = o.comments.map(row => row.body).join("\n\n");
    expect(gradeHireRevision(o).passed).toBe(true);
  });
  it("keeps captured comment and link receipts separate from independently observed evidence", () => {
    const o = validChatRevision();
    expect(o.state.revisionHistoryComment).not.toBe(o.comments[0]);
    expect(o.state.revisionHistoryLink).not.toBe(o.renderedLinkEvidence![0]);
    const observed = structuredClone({ comments: o.comments, links: o.renderedLinkEvidence });
    (o.state.revisionHistoryComment as { body: string }).body = "Changed captured receipt only";
    (o.state.revisionHistoryLink as { href: string }).href = "/ACORN/approvals/approval";
    expect({ comments: o.comments, links: o.renderedLinkEvidence }).toEqual(observed);
    expect(gradeHireRevision(o).passed).toBe(false);
  });
  it.each([
    ["unobserved captured message", (o: IdentityObservation) => { o.comments = []; }],
    ["unbound prose", (o: IdentityObservation) => { delete o.state.revisionHistoryComment; }],
    ["wrong comment company", (o: IdentityObservation) => { (o.state.revisionHistoryComment as { companyId: string }).companyId = "other"; }],
    ["wrong comment source", (o: IdentityObservation) => { (o.state.revisionHistoryComment as { issueId: string }).issueId = "other"; }],
    ["wrong comment actor", (o: IdentityObservation) => { (o.state.revisionHistoryComment as { authorAgentId: string }).authorAgentId = "other"; }],
    ["wrong originating run", (o: IdentityObservation) => { (o.state.revisionHistoryComment as { createdByRunId: string }).createdByRunId = "other"; }],
    ["wrong model in reply", (o: IdentityObservation) => { (o.state.eligibleModels as string[]).push("openrouter/other/other-model"); o.reply = o.reply.replace(String(o.state.cheaperModel), "openrouter/other/other-model"); o.comments[0]!.body = o.reply; (o.state.revisionHistoryComment as { body: string }).body = o.reply; }],
    ["uncommitted run", (o: IdentityObservation) => { o.runs[0]!.resultJson = { finalizationPhase: "pending" }; }],
    ["foreign run company", (o: IdentityObservation) => { o.runs[0]!.companyId = "other"; }],
    ["foreign run actor", (o: IdentityObservation) => { o.runs[0]!.agentId = "other"; }],
    ["foreign run source", (o: IdentityObservation) => { o.runs[0]!.nativeIssueId = "other"; }],
    ["wrong human wake", (o: IdentityObservation) => { o.runs[0]!.contextSnapshot!.commentId = "other"; }],
    ["unobserved rendered link", (o: IdentityObservation) => { o.renderedLinkEvidence = []; }],
    ["different canonical receipt href", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { href: string }).href = "/ACORN/approvals/approval"; }],
    ["wrong captured link source", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { source: string }).source = "project-created-card"; }],
    ["wrong captured link conversation", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { conversationId: string }).conversationId = "other"; }],
    ["wrong captured link comment", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { commentId: string }).commentId = "other"; }],
    ["changed captured message", (o: IdentityObservation) => { (o.state.revisionHistoryComment as { body: string }).body += " Unobserved receipt text"; }],
    ["wrong proposal link", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { href: string }).href = "/approvals/other"; }],
    ["foreign link origin", (o: IdentityObservation) => { (o.state.revisionHistoryLink as { href: string }).href = "https://other.test/approvals/approval"; }],
    ["missing original history", (o: IdentityObservation) => { o.state.approvalComments = []; }],
    ["duplicate resubmit", (o: IdentityObservation) => { o.activity.push({ ...o.activity[1]!, id: "duplicate" }); }],
    ["approved proposal", (o: IdentityObservation) => { (o.state.currentApproval as { status: string }).status = "approved"; }],
    ["created employee", (o: IdentityObservation) => { o.agents.push({ id: "new-hire" }); }],
  ] as const)("rejects bound chat history with %s", (_name, mutate) => { const o = validChatRevision(); mutate(o); expect(gradeHireRevision(o).passed).toBe(false); });
  it("requires actual model choice, attributed history and a still pending proposal", () => { expect(gradeHireRevision(valid()).passed).toBe(true); expect(gradeHireRevision(undefined).passed).toBe(false); });
  it("rejects treating requested revision as approval or activating the hire", () => { const o = valid(); (o.state.currentApproval as { status: string }).status = "approved"; expect(gradeHireRevision(o).passed).toBe(false); const wrong = valid(); wrong.agents.push({ id: "new-hire" }); expect(gradeHireRevision(wrong).passed).toBe(false); });
  it("rejects changing only prose while retaining the expensive config", () => { const o = valid(); (o.state.currentApproval as { payload: { adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: string } } }).payload.adapterConfig.model = "openrouter/deepseek/deepseek-v4-pro"; expect(gradeHireRevision(o).passed).toBe(false); });
  it("rejects an unsupported substituted model and missing historical record", () => { const o = valid(); o.state.eligibleModels = []; expect(gradeHireRevision(o).passed).toBe(false); const wrong = valid(); wrong.state.approvalComments = []; expect(gradeHireRevision(wrong).passed).toBe(false); });
  it.each([
    ["missing price proof", (o: IdentityObservation) => { delete o.state.modelChoice; }],
    ["unrelated original model", (o: IdentityObservation) => { (o.state.originalApproval as { payload: { adapterConfig: { model: string } } }).payload.adapterConfig.model = "openrouter/other/model"; }],
    ["wrong proposed runtime", (o: IdentityObservation) => { (o.state.currentApproval as { payload: { adapterConfig: { provider: string } } }).payload.adapterConfig.provider = "codex"; }],
    ["wrong proposal", (o: IdentityObservation) => { (o.state.currentApproval as { id: string }).id = "other"; }],
    ["wrong company", (o: IdentityObservation) => { (o.state.currentApproval as { companyId: string }).companyId = "other"; }],
    ["wrong requesting agent", (o: IdentityObservation) => { (o.state.currentApproval as { requestedByAgentId: string }).requestedByAgentId = "other"; }],
    ["human decision already saved", (o: IdentityObservation) => { (o.state.currentApproval as { decidedByUserId: string | null }).decidedByUserId = "alex"; }],
    ["changed unrelated configuration", (o: IdentityObservation) => { o.state.originalOtherFieldsPreserved = false; }],
    ["duplicate agent resubmission", (o: IdentityObservation) => { o.activity.push({ ...o.activity[1]!, id: "duplicate" }); }],
    ["approval side effect", (o: IdentityObservation) => { o.activity.push({ id: "approved", action: "approval.approved", entityId: "approval" }); }],
    ["invisible pending proposal", (o: IdentityObservation) => { o.state.pendingProposalVisible = false; }],
  ])("rejects %s", (_label, mutate) => { const o = valid(); mutate(o); expect(gradeHireRevision(o).passed).toBe(false); });
});
