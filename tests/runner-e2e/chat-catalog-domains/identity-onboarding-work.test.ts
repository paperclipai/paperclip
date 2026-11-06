import { describe, expect, it } from "vitest";
import { gradeNewCompany } from "./identity-new-company.js";
import { gradeFirstWork } from "./identity-first-work.js";
import type { IdentityObservation } from "./identity-support.js";
function base(scenarioId: string): IdentityObservation { return { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], interactions: [], documents: [], revisions: [], comments: [], links: [], runs: [], activity: [], reply: "", humanQueries: [], state: {} }; }
function company() {
  const o = base("onboarding.new-company"); o.reply = "Use the company switcher to create an organization for your website business; finish the human onboarding wizard.";
  o.state = { humanId: "alex", companyCountAfterReply: 1, wizard: { companyId: "new-company", firstAgentId: "new-ceo", firstAgentReady: true, hiredThroughPublicSetup: true, actualHarness: "opencode_local", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", noAgentBeforeRouteDeparture: true, savedSetupAgentId: "new-ceo", helloCount: 1, hireCount: 1, exactPublicGrantAndAgentInstall: true, hello: { checks: [{ code: "opencode_hello_probe_passed" }] },
    account: { ownership: "personal", ownerUserId: "alex", responsibleUserId: "alex" }, beforeCompanyIds: ["acorn"], afterCompanyIds: ["acorn", "new-company"], afterAgentIds: ["new-ceo"], draftContainsCredential: false, publicAgentContainsCredential: false, heartbeatRunIds: [] },
    newAgent: { id: "new-ceo", companyId: "new-company", role: "ceo", lifecycleState: "ready" }, humanRoleConfigurationStatus: 200, newCompanyOwnedByHuman: true,
    oldAgentForeignReadStatus: 403, newAgentVisible: true, oldAgentStillSourceCompany: true, sourceMembershipsUnchanged: true, sourceAccountsUnchanged: true }; return o;
}
function website() {
  const o = base("onboarding.first-work"); const work = { id: "website", companyId: "acorn", title: "Acorn Notes website", description: "Website introducing Acorn Notes for science teams", status: "done", assigneeAgentId: "morgan" };
  o.tasks = [work]; o.links = ["/ACO/issues/website"]; o.humanQueries = ["Make me a simple website introducing our business."];
  o.activity = [{ id: "created", action: "issue.created", entityId: "website", agentId: "ceo" }];
  o.runs = [{ id: "worker-run", companyId: "acorn", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "website" } }];
  o.state = { worker: { id: "morgan" }, sourceId: "chat", beforeSourceHumanComments: 0, beforeSourceRuns: 0, sourceStillConversation: true, reviewedAttachmentId: "html",
    websites: [{ attachment: { id: "html", issueId: "website", companyId: "acorn", sha256: "bytes", createdByAgentId: "morgan", originatingRunId: "worker-run" }, sha256: "bytes", body: "<html><body><h1>Acorn Notes</h1><p>Research notes for science teams.</p></body></html>" }],
    visibleArtifactName: true, renderedBusinessHeading: true, renderedBusinessDescription: true, renderedBytesMatch: true, renderedWithoutScriptExecution: true }; return o;
}
describe("human company creation and genuine first completed website", () => {
  it("validates an actual human-created separate company with a real CEO", () => { expect(gradeNewCompany(company()).passed).toBe(true); expect(gradeNewCompany(undefined).passed).toBe(false); });
  it("rejects merely renaming the neutral general agent CEO", () => { const o = company(); (o.state.newAgent as { role: string }).role = "general"; expect(gradeNewCompany(o).passed).toBe(false); });
  it("rejects cross-company agent access or human impersonation", () => { const o = company(); o.state.oldAgentForeignReadStatus = 200; expect(gradeNewCompany(o).passed).toBe(false); const wrong = company(); wrong.state.humanRoleConfigurationStatus = 403; expect(gradeNewCompany(wrong).passed).toBe(false); });
  it("validates the actual run-bound delivered and rendered website", () => { expect(gradeFirstWork(website()).passed).toBe(true); expect(gradeFirstWork(undefined).passed).toBe(false); });
  it("rejects empty task creation even with a finished website reply", () => { const o = website(); o.reply = "The website is complete."; o.state.websites = []; expect(gradeFirstWork(o).passed).toBe(false); });
  it("rejects artifact createdByRunId fiction instead of immutable originatingRunId", () => { const o = website(); const file = (o.state.websites as Array<{ attachment: Record<string, unknown> }>)[0]!; file.attachment.createdByRunId = "worker-run"; delete file.attachment.originatingRunId; expect(gradeFirstWork(o).passed).toBe(false); });
  it("rejects rendered fixture bytes that differ from the actual authorized download", () => { const o = website(); o.state.renderedBytesMatch = false; expect(gradeFirstWork(o).passed).toBe(false); });
});
