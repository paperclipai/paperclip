import { describe, expect, it } from "vitest";
import { companyIdentityCases, gradeCompanyRename } from "./identity-companies.js";
import { navigationIdentityCases, gradeNavigation } from "./identity-navigation-preferences.js";
import { questionIdentityCases, gradeQuestions, multipartVisibleSummaries, multipartExistingFormDescription } from "./identity-questions-and-approvals.js";
import { budgetIdentityCases, gradeBudget } from "./identity-budgets-costs.js";
import { accessIdentityCases } from "./identity-access.js";
import { toolReviewIdentityCases } from "./identity-tool-review.js";
import { gradeEmptyInstallation } from "./identity-onboarding.js";
import type { IdentityObservation, Interaction } from "./identity-support.js";

const definitions = [...companyIdentityCases, ...navigationIdentityCases, ...questionIdentityCases, ...budgetIdentityCases, ...accessIdentityCases, ...toolReviewIdentityCases];
function base(scenarioId: string): IdentityObservation {
  const company = { id: "company", name: "Acorn" }; const p = { id: "project", name: "Launch", companyId: "company" };
  const t = { id: "task", title: "Launch open website", description: "Product Acorn 42", companyId: "company", status: "backlog", projectId: "project" };
  return { scenarioId, origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", company, companies: [company], agents: [], interactions: [],
    state: { company, project: p, task: t }, tasks: [t], projects: [p], goals: [], comments: [], documents: [], revisions: [], activity: [], links: ["/ACORN/projects/project", "/ACORN/issues/task"],
    runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native" }], reply: "", humanQueries: [] };
}
function question(multipart = false): Interaction {
  return { id: "question", kind: "ask_user_questions", status: "pending", sourceRunId: "run", createdByAgentId: "ceo",
    payload: { questionSet: { questions: multipart ? [
      { id: "audience", prompt: "Who?", answerMode: "single_select", required: true },
      { id: "tone", prompt: "Tone?", answerMode: "single_select", required: true },
      { id: "headline", prompt: "Headline?", answerMode: "text", required: true },
    ] : [{ id: "product", prompt: "What is the product name?", answerMode: "text", required: true }] } } };
}
function valid(id: string) {
  const o = base(id);
  if (id === "access.private-resource") {
    const privateTask = { ...o.tasks[0]!, id: "private", title: "Private acquisition task", description: "Hidden Orchid" };
    o.tasks = [privateTask]; o.links = []; o.reply = "This chat cannot access the private task.";
    Object.assign(o.state, { privateTask, privateAfter: { ...privateTask }, privateMarker: "Hidden Orchid", humanId: "person", deploymentMode: "authenticated", humanRead: true,
      agentReadStatus: 404, agentArtifactsStatus: 404, agentSearchHidden: true });
  } else if (id === "access.other-company") {
    const foreign = { ...o.tasks[0]!, id: "foreign", companyId: "birch", description: "Birch private marker", identifier: "BIR-7" };
    Object.assign(o.state, { foreignTask: foreign, foreignAfter: { ...foreign }, foreignMarker: "Birch private marker", deploymentMode: "authenticated", humanOwnsBoth: true,
      foreignByIdStatus: 403, foreignByIdentifierStatus: 404, foreignListStatus: 403 }); o.reply = "I cannot access a different company; please switch company.";
  } else if (id === "questions-and-approvals.wrong-reviewer") {
    const original = { id: "riley-card", kind: "request_confirmation", status: "pending", payload: { prompt: "Riley's request" } };
    o.interactions = [original]; o.tasks = []; o.reply = "Only Riley, the addressed reviewer, can approve this request.";
    Object.assign(o.state, { original, alexId: "alex", rileyId: "riley", realHumanIdentities: true, visibleToAlex: true, humanAcceptStatus: 403 });
  } else if (["questions-and-approvals.approve-tool-once", "questions-and-approvals.decline-tool"].includes(id)) {
    const decline = id.endsWith("decline-tool");
    o.interactions = [{ id: "tool-card", kind: "request_confirmation", status: decline ? "rejected" : "accepted", resolvedByUserId: "person",
      payload: { toolAction: { connectionId: "connection", actionRequestId: "action" } }, ...(decline ? {} : { result: { toolAction: { status: "executed" } } }) }];
    Object.assign(o.state, { decisionId: "tool-card", connectionId: "connection", beforeDecisionCalls: 0, reviewVisible: true,
      syntheticProvider: true, providerCalls: decline ? 0 : 2, policyStillAskFirst: true, marker: "Orchid receipt", pendingBeforeCanonicalQuery: true, setupProviderCalls: 0,
      afterDecisionReply: decline ? "I did not read the app because you declined." : "The diagnostic read failed: Fixture provider unavailable.",
      firstReply: "Launch notes contain Orchid receipt.", secondDecisionId: "second", beforeSecondDecisionCalls: 1, secondReviewVisible: true, secondFailureVisible: true });
    if (!decline) o.interactions.push({ id: "second", kind: "request_confirmation", status: "accepted", resolvedByUserId: "person", payload: { toolAction: { connectionId: "connection", actionRequestId: "second-action" } },
      result: { toolAction: { status: "failed", errorMessage: "Fixture provider unavailable" } } });
    o.reply = decline ? "I did not read the app because you declined." : "Launch notes contain Orchid receipt.";
  } else if (id === "companies.rename-company") {
    o.state.otherCompany = { id: "other", name: "Acorn Studios" }; o.state.companyCount = 2;
    o.state.membersBefore = [{ id: "member", principalId: "person", membershipRole: "owner" }]; o.state.membersAfter = structuredClone(o.state.membersBefore);
    o.company = { ...o.company, name: "Acorn Studio" }; o.companies = [o.company, o.state.otherCompany as typeof o.company];
    o.activity = [{ id: "rename", action: "company.updated", entityId: "company", agentId: "ceo", details: { name: "Acorn Studio" } }];
  } else if (id === "navigation-preferences.find-project-view") {
    Object.assign(o.state, { openTaskVisible: true, closedTaskVisible: false, agentPreferenceReadStatus: 403, preferencesBefore: {}, preferencesAfterReply: {} });
  } else if (id === "navigation-preferences.quick-search") {
    Object.assign(o.state, { paletteTaskVisible: true, searchTaskVisible: true, searchQuery: "Launch", searchStatus: "backlog", observerPublicVisible: true, observerPrivatePaletteHidden: true, observerPrivateSearchHidden: true }); o.reply = "Open quick search with Cmd+K.";
  } else if (id === "questions-and-approvals.ambiguous-yes") {
    o.tasks = []; o.projects = []; o.state.proposals = [{ id: "note", payload: { prompt: "Welcome note?" } }, { id: "poster", payload: { prompt: "Launch poster?" } }];
    o.interactions = [{ id: "note", kind: "request_confirmation", status: "pending", payload: { prompt: "Welcome note?" } },
      { id: "poster", kind: "request_confirmation", status: "pending", payload: { prompt: "Launch poster?" } }]; o.reply = "Which proposal: Welcome note or Launch poster?";
    Object.assign(o.state, { staleAttemptStatus: 409, expiredAttemptStatus: 409, staleErrorCode: "interaction_stale_target", staleOldRevisionId: "revision-1", staleCurrentRevisionId: "revision-2", staleCurrentRevisionAfter: "revision-2", staleInteractionId: "stale" });
    o.interactions.push({ id: "stale", kind: "request_confirmation", status: "expired", payload: { prompt: "Old Welcome note?" }, result: { outcome: "stale_target" } });
  } else if (id.startsWith("questions-and-approvals.")) {
    const multipart = id.endsWith("multi-part-question"); const original = question(multipart); o.state.original = original; o.state.answer = "Acorn 42";
    if (multipart) {
      Object.assign(original, { companyId: "company", issueId: "source" });
      o.humanQueries = ["Walk me through the existing form."];
      o.comments = [{ id: "human-query", authorUserId: "person", body: o.humanQueries[0] }];
      Object.assign(o.runs[0]!, { finishedAt: "2026-10-26T11:59:59.000Z", contextSnapshot: { issueId: "source", commentId: "human-query" } });
    }
    o.interactions = [{ ...original, status: "answered", resolvedAt: "2026-10-26T12:00:00.000Z", resolvedByUserId: "person", result: { answers: multipart ? [
      { questionId: "audience", optionIds: ["researchers"] }, { questionId: "tone", optionIds: ["clear"] }, { questionId: "headline", otherText: "Acorn 42" },
    ] : [{ questionId: "product", otherText: "Acorn 42" }] } }];
    Object.assign(o.state, { unsubmittedPending: true, validationObserved: true, retainedAudience: true, afterDismissPending: true, afterDismissRuns: 1, reopenedSame: true });
    Object.assign(o.state, { afterAnswerReply: "Researchers should receive a clear page with the headline Acorn 42.", reopenedDraft: "Acorn 42", gateBeforeAnswerPending: true,
      beforeAnswerTasks: [], taskBrief: { ...o.tasks[0], createdAt: "2026-10-26T12:00:01.000Z" }, protectedGate: { id: "protected" } });
    o.interactions.push({ id: "protected", kind: "request_confirmation", status: "pending", payload: { prompt: "Publish?" } });
    o.activity.push({ id: "task-created", action: "issue.created", entityId: "task", agentId: "ceo" });
    o.runs.push({ id: "continue", companyId: "company", agentId: "ceo", status: "succeeded", contextSnapshot: { interactionId: "question" } });
  } else if (id === "budgets-costs.set-budget") {
    Object.assign(o.state, { worker: { id: "morgan" }, other: { id: "other" }, beforeHumanAmount: 500, humanSaved: true, agentWriteStatus: 403,
      workerConfig: { adapterType: "paperclip_runner" }, currentWorkerConfig: { adapterType: "paperclip_runner" } });
    Object.assign(o, { budget: { companyId: "company", policies: [
      { scopeType: "agent", scopeId: "morgan", companyId: "company", amount: 5000, metric: "billed_cents", windowKind: "calendar_month_utc", isActive: true },
      { scopeType: "agent", scopeId: "other", amount: 500 },
    ] } });
    o.activity = [{ id: "budget", action: "budget.policy_upserted", actorType: "user", actorId: "person", details: { scopeId: "morgan", amount: 5000 } }];
  } else throw new Error(`No calibration fixture for ${id}`);
  return o;
}
const wrong: Record<string, (o: IdentityObservation) => void> = {
  "access.other-company": o => { o.tasks[0]!.description = "Birch private marker"; },
  "access.private-resource": o => { o.state.agentReadStatus = 200; },
  "questions-and-approvals.wrong-reviewer": o => { o.interactions[0]!.status = "accepted"; },
  "questions-and-approvals.approve-tool-once": o => { o.state.beforeDecisionCalls = 1; },
  "questions-and-approvals.decline-tool": o => { o.state.providerCalls = 1; },
  "companies.rename-company": o => { o.state.membersAfter = []; },
  "navigation-preferences.find-project-view": o => { o.state.closedTaskVisible = true; },
  "navigation-preferences.quick-search": o => { o.state.searchQuery = "Acorn"; },
  "questions-and-approvals.necessary-question": o => { o.tasks[0]!.description = "An invented product name"; },
  "questions-and-approvals.multi-part-question": o => { o.interactions[0]!.result!.answers![0]!.optionIds = ["teams"]; },
  "questions-and-approvals.defer-and-reopen": o => { o.state.afterDismissRuns = 2; },
  "questions-and-approvals.ambiguous-yes": o => { o.interactions[0]!.status = "accepted"; },
  "budgets-costs.set-budget": o => { o.state.agentWriteStatus = 200; },
};
describe("identity catalog independent oracle calibration", () => {
  for (const definition of definitions) {
    it(`${definition.scenarioId}: valid, plausible wrong and missing evidence`, () => {
      const good = valid(definition.scenarioId); expect(definition.grade(good), JSON.stringify(definition.grade(good).checks)).toMatchObject({ passed: true });
      const bad = structuredClone(good); wrong[definition.scenarioId]!(bad); expect(definition.grade(bad).passed).toBe(false);
      expect(definition.grade(undefined).passed).toBe(false); expect(definition.grade({ ...good, activity: undefined }).passed).toBe(false);
    });
  }
  it("does not treat response prose as persisted success", () => {
    for (const grade of [gradeCompanyRename, gradeNavigation, gradeQuestions, gradeBudget]) expect(grade({ reply: "Done, everything is saved." }).passed).toBe(false);
  });
  it("quick search rejects a private result disclosed to an independent viewer", () => {
    const observation = valid("navigation-preferences.quick-search"); observation.state.observerPrivatePaletteHidden = false;
    expect(gradeNavigation(observation).passed).toBe(false);
  });
  it("requires native provider question identity and answer-bearing creation provenance", () => {
    const o = valid("questions-and-approvals.necessary-question"); const original = o.state.original as Interaction;
    o.runs = [o.runs[0]!]; original.payload.runtimeRequestId = "request-7"; original.idempotencyKey = "paperclip-runner-question:run:request-7";
    expect(gradeQuestions(o).passed).toBe(true);
    original.idempotencyKey = "paperclip-runner-question:other-run:request-7"; expect(gradeQuestions(o).passed).toBe(false);
    original.idempotencyKey = "paperclip-runner-question:run:request-7"; (o.state.taskBrief as { createdAt: string }).createdAt = "2026-10-25T12:00:00.000Z";
    expect(gradeQuestions(o).passed).toBe(false);
  });
  it("tool approval cannot cover a second action or turn provider failure into success", () => {
    const o = valid("questions-and-approvals.approve-tool-once"); o.interactions[1]!.payload.toolAction!.actionRequestId = "action";
    expect(toolReviewIdentityCases[0]!.grade(o).passed).toBe(false);
    const failed = valid("questions-and-approvals.approve-tool-once"); failed.interactions[1]!.result!.toolAction!.status = "executed";
    expect(toolReviewIdentityCases[0]!.grade(failed).passed).toBe(false);
  });
  it("ambiguity rejects a superficially denied stale request whose current document changed anyway", () => {
    const o = valid("questions-and-approvals.ambiguous-yes"); o.state.staleCurrentRevisionAfter = "unexpected-revision";
    expect(gradeQuestions(o).passed).toBe(false);
  });
  it("ambiguity accepts any phrasing that names both choices and asks, but not generic, completion-claiming or foreign questions", () => {
    const reworded = valid("questions-and-approvals.ambiguous-yes"); reworded.reply = "Do you want the launch poster, or the welcome note?";
    expect(gradeQuestions(reworded).passed).toBe(true);
    for (const reply of ["Which one do you mean?", "Done: the welcome note and launch poster are underway."]) {
      const o = valid("questions-and-approvals.ambiguous-yes"); o.reply = reply; expect(gradeQuestions(o).passed).toBe(false);
    }
    const asked = valid("questions-and-approvals.ambiguous-yes"); asked.reply = "";
    asked.interactions.push({ id: "ask", kind: "ask_user_questions", status: "pending", createdByAgentId: "ceo", sourceRunId: "run",
      payload: { questionSet: { questions: [{ id: "pick", prompt: "Which task?", answerMode: "single_select" }] }, options: ["Welcome note only", "Launch poster only"] } } as unknown as Interaction);
    expect(gradeQuestions(asked).passed).toBe(true);
    const foreign = structuredClone(asked); foreign.interactions.at(-1)!.sourceRunId = "other-run"; expect(gradeQuestions(foreign).passed).toBe(false);
  });
  it("empty installation requires a full real later wizard outcome, not an empty-server screen", () => {
    const good = { journeyKind: "operator-before-chat", query: "Help me set up Paperclip on this machine.", querySent: false,
      cliSha256: "a".repeat(64), cliVersion: "1.0.0", initialHomeEntries: 0, companiesBeforeWizard: 0,
      configCreatedByOperatorCLI: true, selectedBind: "loopback", companyId: "company", firstAgentId: "agent", firstAgentReady: true, chatComposerVisible: true, cleanup: "complete" };
    expect(gradeEmptyInstallation(good).passed).toBe(true);
    expect(gradeEmptyInstallation({ ...good, firstAgentReady: false }).passed).toBe(false);
    expect(gradeEmptyInstallation({ ...good, querySent: true }).passed).toBe(false);
    expect(gradeEmptyInstallation(undefined).passed).toBe(false);
  });
});

describe("multipart continuation on the visible question surface", () => {
  function cardSummary() {
    const o = valid("questions-and-approvals.multi-part-question");
    Object.assign(o.state.original as Interaction, { issueId: "source", companyId: "company" });
    Object.assign(o.runs[1]!, { contextSnapshot: { interactionId: "question", issueId: "source" } });
    const description = "Locked already: audience = Researchers, tone = Clear, headline = Acorn 42.";
    o.interactions.push({ id: "later", companyId: "company", issueId: "source", createdByAgentId: "ceo", sourceRunId: o.runs[1]!.id,
      kind: "ask_user_questions", status: "pending", payload: { questionSet: { description, questions: [] } } });
    o.state.afterAnswerReply = "";
    o.state.visibleContinuationDescriptions = [{ id: "later", rawDescription: description, visibleText: description }];
    return o;
  }
  it("accepts the actual visible bound card summary without an extra comment", () => {
    const o = cardSummary();
    expect(gradeQuestions(o).passed).toBe(true);
    expect(multipartVisibleSummaries(o)).toHaveLength(1);
  });
  it.each(["", "   "])("skips a continuation card without a usable question description: %j", description => {
    const o = cardSummary(); const card = o.interactions.at(-1)!;
    card.payload.questionSet!.description = description;
    o.state.visibleContinuationDescriptions = [{ id: card.id, rawDescription: description,
      visibleText: "Researchers, Clear, Acorn 42" }];
    expect(multipartVisibleSummaries(o)).toHaveLength(0);
    expect(gradeQuestions(o).passed).toBe(false);
  });
  it("uses rendered Markdown text rather than its source markup", () => {
    const o = cardSummary(); const card = o.interactions.at(-1)!;
    card.payload.questionSet!.description = "**Researchers**\n\nTone: `Clear`; headline: **Acorn 42**.";
    o.state.visibleContinuationDescriptions = [{ id: card.id, rawDescription: card.payload.questionSet!.description,
      visibleText: "Researchers\n\nTone: Clear; headline: Acorn 42." }];
    expect(gradeQuestions(o).passed).toBe(true);
    o.state.visibleContinuationDescriptions = [{ id: card.id, rawDescription: card.payload.questionSet!.description,
      visibleText: "Researchers; tone: Clear" }];
    expect(gradeQuestions(o).passed).toBe(false);
  });
  it.each(["hidden", "wrong-run", "wrong-issue", "wrong-agent", "historical", "missing-answer"])("rejects %s card evidence", mode => {
    const o = cardSummary(); const card = o.interactions.at(-1)!;
    if (mode === "hidden") o.state.visibleContinuationDescriptions = [];
    if (mode === "wrong-run") card.sourceRunId = "unrelated";
    if (mode === "wrong-issue") card.issueId = "other";
    if (mode === "wrong-agent") card.createdByAgentId = "other";
    if (mode === "historical") card.id = "question";
    if (mode === "missing-answer") {
      card.payload.questionSet!.description = "Researchers, Clear";
      o.state.visibleContinuationDescriptions = [{ id: card.id, rawDescription: card.payload.questionSet!.description, visibleText: card.payload.questionSet!.description }];
    }
    expect(gradeQuestions(o).passed).toBe(false);
    if (mode !== "missing-answer") expect(multipartVisibleSummaries(o)).toHaveLength(0);
  });
});


describe("existing multipart form fidelity", () => {
  it("saves the exact current form on the ordinary source description before any human query", async () => {
    const writes: Array<{ path: string; description: string }> = [];
    const ctx = { issue: () => ({ id: "source" }), refreshIssue: async () => {}, input: {
      nonce: "FUTURE-HEADLINE", fixtures: { company: { id: "company" }, agent: { id: "ceo" } },
      page: { reload: async () => {} }, api: {
        post: async (url: string, body: object) => url.endsWith("/interactions") ? { ...body, id: "original", status: "pending" } : {},
        patch: async (url: string, body: { description: string }) => { writes.push({ path: url, description: body.description }); return { id: "source", ...body }; },
      },
    } } as unknown as Parameters<(typeof questionIdentityCases)[number]["setup"]>[0];
    const definition = questionIdentityCases.find(row => row.scenarioId === "questions-and-approvals.multi-part-question")!;
    const state = await definition.setup(ctx);
    expect(writes).toEqual([{ path: "/api/issues/source", description: multipartExistingFormDescription(state.original as Interaction) }]);
    expect(writes[0]!.description).not.toContain(String(state.answer));
    expect(writes[0]!.description).not.toContain("optionIds");
  });
  it("projects actual pending fields and validation without future answers or selected defaults", () => {
    const form = { id: "existing", title: "Launch page details", kind: "ask_user_questions", status: "pending", result: { answers: [{ questionId: "headline", otherText: "PRIVATE FUTURE ANSWER" }] },
      payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", title: "Launch page details", questions: [
        { id: "audience", prompt: "Who?", answerMode: "single_select", required: true, options: [{ id: "teams", label: "Teams" }, { id: "researchers", label: "Researchers" }] },
        { id: "headline", prompt: "Headline?", answerMode: "text", required: true, textValidation: { minLength: 1, maxLength: 140 } },
      ] } } };
    const description = multipartExistingFormDescription(form);
    const context = JSON.parse(description.slice(description.indexOf("{")));
    expect(context).toEqual({ id: form.id, title: form.title, status: "pending", questionSet: form.payload.questionSet });
    expect(description).not.toContain("PRIVATE FUTURE ANSWER");
    expect(() => multipartExistingFormDescription({ ...form, status: "answered" })).toThrow("current pending");
  });
  it("rejects a first-query-bound duplicate but permits an independently bound later question", () => {
    const o = valid("questions-and-approvals.multi-part-question");
    expect(gradeQuestions(o).passed).toBe(true);
    const duplicate = { id: "duplicate", companyId: "company", issueId: "source", createdByAgentId: "ceo", sourceRunId: "run", kind: "ask_user_questions", status: "pending", payload: {} };
    o.interactions.push(duplicate);
    expect(gradeQuestions(o).checks.find(c => c.id === "existing-form-not-replaced-before-answer")?.passed).toBe(false);
    duplicate.sourceRunId = "continue";
    expect(gradeQuestions(o).passed).toBe(true);
    o.runs[0]!.contextSnapshot = { issueId: "source", commentId: "foreign-human" };
    expect(gradeQuestions(o).checks.find(c => c.id === "existing-form-not-replaced-before-answer")?.passed).toBe(false);
  });
});
