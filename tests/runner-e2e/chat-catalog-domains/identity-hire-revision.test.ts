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
describe("formal hire remains a proposal after cost revision", () => {
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
