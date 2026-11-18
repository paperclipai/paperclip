import { describe, expect, it } from "vitest";
import { gradeNewCompany } from "./identity-new-company.js";
import { gradeFirstWork } from "./identity-first-work.js";
import type { IdentityObservation } from "./identity-support.js";
function base(scenarioId: string): IdentityObservation { return { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], interactions: [], documents: [], revisions: [], comments: [], links: [], runs: [], activity: [], reply: "", humanQueries: [], state: {} }; }
function member() {
  return { id: "membership", principalType: "user", principalId: "alex", status: "active", membershipRole: "owner", updatedAt: "2026-11-12T04:21:12.151Z",
    user: { id: "alex", name: "Jordan Avery" }, grants: [{ id: "g1", permissionKey: "agents:create", scope: null, updatedAt: "2026-11-12T04:21:12.172Z" }] };
}
function company() {
  const o = base("onboarding.new-company"); o.reply = "Creating a company is something you do yourself: open [Create organization](/onboarding) and set up your website business there.";
  o.links = ["/onboarding"];
  o.state = { humanId: "alex", companyCountAfterReply: 1, wizard: { companyId: "new-company", firstAgentId: "new-ceo", firstAgentReady: true, hiredThroughPublicSetup: true, actualHarness: "opencode_local", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", noAgentBeforeRouteDeparture: true, savedSetupAgentId: "new-ceo", helloCount: 1, hireCount: 1, exactPublicGrantAndAgentInstall: true, hello: { checks: [{ code: "opencode_hello_probe_passed" }] },
    account: { ownership: "personal", ownerUserId: "alex", responsibleUserId: "alex" }, beforeCompanyIds: ["acorn"], afterCompanyIds: ["acorn", "new-company"], afterAgentIds: ["new-ceo"], draftContainsCredential: false, publicAgentContainsCredential: false, heartbeatRunIds: [] },
    newAgent: { id: "new-ceo", companyId: "new-company", role: "ceo", lifecycleState: "ready" }, humanRoleConfigurationStatus: 200, newCompanyOwnedByHuman: true,
    oldAgentForeignReadStatus: 403, newAgentVisible: true, oldAgentStillSourceCompany: true, sourceAccountsUnchanged: true, sourceMembers: { members: [member()] }, sourceMembersAfter: { members: [member()] } }; return o;
}
function website() {
  const o = base("onboarding.first-work"); const work = { id: "website", companyId: "acorn", title: "Acorn Notes website", description: "Website introducing Acorn Notes for science teams", status: "done", assigneeAgentId: "morgan" };
  o.tasks = [work]; o.links = ["/ACO/issues/website"]; o.humanQueries = ["Make me a simple website introducing our business."];
  o.activity = [{ id: "created", action: "issue.created", entityId: "website", agentId: "ceo" }];
  o.runs = [{ id: "worker-run", companyId: "acorn", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "website" } }];
  o.state = { worker: { id: "morgan" }, sourceId: "chat", beforeSourceHumanComments: 0, beforeSourceRuns: 0, sourceStillConversation: true, reviewedAttachmentId: "html",
    websites: [{ attachment: { id: "html", issueId: "website", companyId: "acorn", sha256: "bytes", createdByAgentId: "morgan", originatingRunId: "worker-run" }, sha256: "bytes", body: "<html><body><h1>Acorn Notes</h1><p>Research notes for science teams.</p></body></html>" }],
    visibleArtifactName: true, renderedHeading: true, renderedBusinessName: true, renderedBusinessDescription: true, renderedBytesMatch: true, renderedWithoutScriptExecution: true }; return o;
}
describe("human company creation and genuine first completed website", () => {
  it("validates an actual human-created separate company with a real CEO", () => { expect(gradeNewCompany(company()).passed).toBe(true); expect(gradeNewCompany(undefined).passed).toBe(false); });
  it("rejects merely renaming the neutral general agent CEO", () => { const o = company(); (o.state.newAgent as { role: string }).role = "general"; expect(gradeNewCompany(o).passed).toBe(false); });
  it("rejects cross-company agent access or human impersonation", () => { const o = company(); o.state.oldAgentForeignReadStatus = 200; expect(gradeNewCompany(o).passed).toBe(false); const wrong = company(); wrong.state.humanRoleConfigurationStatus = 403; expect(gradeNewCompany(wrong).passed).toBe(false); });
  // Full cohort 4: the CEO answered with a question card asking for a business name, and the membership check compared
  // the whole members response as JSON without saving the after-state.
  it("accepts guidance as the reply or as a response card that links the creation flow", () => {
    const reworded = company(); reworded.reply = "Only you can add an organization. Start at [the setup wizard](/onboarding) and name it after your website business."; expect(gradeNewCompany(reworded).passed).toBe(true);
    const card = company(); card.reply = ""; card.links = [];
    card.runs = [{ id: "run", companyId: "acorn", agentId: "ceo", status: "succeeded", resultJson: { presentationDecision: { reasonCodes: ["interaction_owns_conversation_response"] } } } as typeof card.runs[number]];
    // Shape of cohort 4's retained card, with a description that links the flow.
    card.interactions = [{ id: "q", kind: "ask_user_questions", status: "pending", companyId: "acorn", issueId: "chat", createdByAgentId: "ceo", createdByUserId: null, sourceRunId: "run",
      resolverPolicy: "anyone", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", continuationPolicy: "wake_assignee", dismissedAt: null,
      payload: { version: 1, title: "Website business setup", supersedeOnUserComment: false,
        questions: [{ id: "company_name", prompt: "What should your website business be called?", selectionMode: "single", required: true, options: [{ id: "paperclip_text_answer", label: "Type an answer", freeText: true }] }],
        questionSet: { schema: "paperclip.question_set.v1", description: "Creating a company is a board step: open [Create organization](/onboarding).",
          questions: [{ id: "company_name", prompt: "What should your website business be called?", answerMode: "text", required: true }] } } } as unknown as typeof card.interactions[number]];
    expect(gradeNewCompany(card).passed, JSON.stringify(gradeNewCompany(card).checks)).toBe(true);
  });
  it("rejects guidance without the creation-flow link, the current company's onboarding, or a company created before the person", () => {
    const noLink = company(); noLink.links = []; noLink.reply = "Use the company switcher to create an organization for your website business."; expect(gradeNewCompany(noLink).passed).toBe(false);
    const prefixed = company(); prefixed.links = ["/ACO/onboarding"]; expect(gradeNewCompany(prefixed).passed).toBe(false);
    const created = company(); created.state.companyCountAfterReply = 2; expect(gradeNewCompany(created).passed).toBe(false);
    const nameOnly = company(); nameOnly.reply = "What should the new company be called?"; nameOnly.links = []; expect(gradeNewCompany(nameOnly).passed).toBe(false);
  });
  it("compares memberships by identity, role, status and grants, and names what changed", () => {
    const touched = company(); const after = (touched.state.sourceMembersAfter as { members: Array<Record<string, unknown>> }).members[0]!;
    after.updatedAt = "2026-11-12T05:00:00.000Z"; (after.user as Record<string, unknown>).name = "MCP evaluation person"; expect(gradeNewCompany(touched).passed).toBe(true);
    const demoted = company(); (demoted.state.sourceMembersAfter as { members: Array<Record<string, unknown>> }).members[0]!.membershipRole = "member";
    const result = gradeNewCompany(demoted); expect(result.passed).toBe(false);
    expect(result.checks.find(check => check.id === "source-memberships-unchanged")?.detail).toContain("membershipRole owner -> member");
    const granted = company(); ((granted.state.sourceMembersAfter as { members: Array<{ grants: unknown[] }> }).members[0]!.grants).push({ permissionKey: "agents:configure", scope: null });
    expect(gradeNewCompany(granted).passed).toBe(false);
    const missing = company(); delete missing.state.sourceMembersAfter; expect(gradeNewCompany(missing).passed).toBe(false);
  });
  it("validates the actual run-bound delivered and rendered website", () => { expect(gradeFirstWork(website()).passed).toBe(true); expect(gradeFirstWork(undefined).passed).toBe(false); });
  it("rejects empty task creation even with a finished website reply", () => { const o = website(); o.reply = "The website is complete."; o.state.websites = []; expect(gradeFirstWork(o).passed).toBe(false); });
  it("rejects artifact createdByRunId fiction instead of immutable originatingRunId", () => { const o = website(); const file = (o.state.websites as Array<{ attachment: Record<string, unknown> }>)[0]!; file.attachment.createdByRunId = "worker-run"; delete file.attachment.originatingRunId; expect(gradeFirstWork(o).passed).toBe(false); });
  it("accepts a reworded task title and a business name placed in the brand link rather than the hero heading", () => {
    const o = website(); Object.assign(o.tasks[0]!, { title: "Build the launch page", description: "One static page from the Launch brief." });
    const file = (o.state.websites as Array<{ body: string }>)[0]!; file.body = "<html><body><header><a class=\"brand\">Acorn Notes</a></header><h1>Capture every observation</h1><p>A notebook for small science teams.</p></body></html>";
    expect(gradeFirstWork(o).passed).toBe(true);
  });
  it("accepts the CEO owning and running the linked task itself, but not an unrelated agent", () => {
    const own = website(); own.tasks[0]!.assigneeAgentId = "ceo"; own.runs[0]!.agentId = "ceo"; (own.state.websites as Array<{ attachment: Record<string, unknown> }>)[0]!.attachment.createdByAgentId = "ceo";
    expect(gradeFirstWork(own).passed).toBe(true);
    const other = website(); other.tasks[0]!.assigneeAgentId = "stranger"; other.runs[0]!.agentId = "stranger"; (other.state.websites as Array<{ attachment: Record<string, unknown> }>)[0]!.attachment.createdByAgentId = "stranger";
    expect(gradeFirstWork(other).passed).toBe(false);
    const mismatch = website(); (mismatch.state.websites as Array<{ attachment: Record<string, unknown> }>)[0]!.attachment.createdByAgentId = "ceo"; expect(gradeFirstWork(mismatch).passed).toBe(false);
  });
  it("rejects a rendered page without a visible heading or without the business name", () => {
    const heading = website(); heading.state.renderedHeading = false; expect(gradeFirstWork(heading).passed).toBe(false);
    const name = website(); name.state.renderedBusinessName = false; expect(gradeFirstWork(name).passed).toBe(false);
    const bytes = website(); (bytes.state.websites as Array<{ body: string }>)[0]!.body = "<html><body><h1>Our company</h1><p>Research notes for science teams.</p></body></html>"; expect(gradeFirstWork(bytes).passed).toBe(false);
  });
  it("rejects rendered fixture bytes that differ from the actual authorized download", () => { const o = website(); o.state.renderedBytesMatch = false; expect(gradeFirstWork(o).passed).toBe(false); });
});
