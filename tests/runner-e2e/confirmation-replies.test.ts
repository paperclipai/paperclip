import { gradeUnansweredQuestion, type UnansweredQuestionEvidence } from "./confirmation-replies.js";
import { describe, expect, it, vi } from "vitest";
import { gradeConfirmationReply, assertAmbiguousReplyUnresolved, ambiguousConfirmationFixtures } from "./confirmation-replies.js";
import { firstTaskScenario } from "./first-task-cases.js";
import type { FirstTaskEvidence } from "./first-task-scoring.js";
import { provisionFirstTaskFixtures } from "./first-task-fixtures.js";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

function recording(rejected = false): FirstTaskEvidence {
  const caseId = rejected ? "reject-no-execution" : "task-reply-accept";
  const scenario = firstTaskScenario(caseId, "oracle");
  const card = { id: "proposal", kind: "request_confirmation", status: "pending" };
  const base = { issueId: "onboard", tasks: [{ id: "onboard" }], agents: [], comments: [], interactions: [card], documents: [], runs: [] };
  const message = { id: "user-answer", authorUserId: "user", body: rejected ? scenario.rejection : scenario.acceptance, createdAt: "2026-09-29T00:01:00Z" };
  return { caseId, nonce: "oracle", onboardingIssueId: "onboard", agentId: "planner", initialTaskIds: ["onboard"], instructions: [], configuredModel: null, observedModels: [], checks: [], checkpoints: [
    { ...base, id: "before", phase: "response", at: "2026-09-29T00:00:00Z" },
    { ...base, id: "decision", phase: rejected ? "rejected" : "accepted", at: message.createdAt, comments: [message] },
    { ...base, id: "after", phase: "finished", at: "2026-09-29T00:03:00Z", comments: [message], runs: [{ id: "resolver", agentId: "planner" }],
      tasks: [{ id: "onboard" }, ...rejected ? [] : [{ id: "child", createdAt: "2026-09-29T00:02:01Z" }]],
      interactions: [{ ...card, status: rejected ? "rejected" : "accepted", resolvedAt: "2026-09-29T00:02:00Z", resolvedByAgentId: "planner", resolvedByRunId: "resolver", result: { outcome: rejected ? "rejected" : "accepted", commentId: message.id } }] },
  ] };
}
describe("confirmation-reply independent oracle", () => {
  it("uses valid public confirmation fixtures without treating checkbox defaults as consent", () => {
    expect(ambiguousConfirmationFixtures).toHaveLength(2);
    const checkbox = ambiguousConfirmationFixtures[1]!;
    expect(checkbox.kind).toBe("request_checkbox_confirmation");
    expect(checkbox.payload).toMatchObject({ minSelected: 1, defaultSelectedOptionIds: ["poster"] });
  });
  it.each([false, true])("accepts the recorded decision with provenance (rejection=%s)", rejected => {
    expect(gradeConfirmationReply(recording(rejected)).every(c => c.passed)).toBe(true);
  });
  it.each(["pending", "expired", "wrong-message", "wrong-agent", "no-run", "wrong-run-agent", "missing-time", "no-card", "too-late", "multiple-pending", "opposite"])("rejects plausible wrong outcome: %s", kind => {
    const e = recording(), last = e.checkpoints.at(-1)!, card = last.interactions[0]!;
    if (kind === "pending" || kind === "expired") card.status = kind;
    if (kind === "wrong-message") card.result.commentId = "another-message";
    if (kind === "wrong-agent") card.resolvedByAgentId = "someone-else";
    if (kind === "no-run") last.runs = [];
    if (kind === "wrong-run-agent") last.runs[0]!.agentId = "someone-else";
    if (kind === "missing-time") delete card.resolvedAt;
    if (kind === "no-card") e.checkpoints[0]!.interactions = [];
    if (kind === "too-late") card.resolvedAt = "2026-09-29T00:02:02Z";
    if (kind === "multiple-pending") e.checkpoints[0]!.interactions.push({ id: "another-proposal", kind: "request_confirmation", status: "pending" });
    if (kind === "opposite") card.result.outcome = "rejected";
    expect(gradeConfirmationReply(e).some(c => !c.passed)).toBe(true);
  });
  it("does not treat checkbox defaults as a persisted selection", () => {
    const e = recording(), card = e.checkpoints.at(-1)!.interactions[0]!;
    card.kind = "request_checkbox_confirmation";
    expect(gradeConfirmationReply(e).every(c => c.passed)).toBe(false);
    card.result.selectedOptionIds = ["welcome-note"];
    expect(gradeConfirmationReply(e).every(c => c.passed)).toBe(true);
  });
  it("requires clarification and no effects for ambiguous approval", () => {
    const e = { cards: [{ id: "a", status: "pending" }, { id: "b", status: "pending" }], originalIds: ["a", "b"], tasks: [], reply: "Which proposal do you mean: the note or the poster?" };
    expect(() => assertAmbiguousReplyUnresolved(e)).not.toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, cards: [{ id: "a", status: "accepted" }, e.cards[1]!] })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, tasks: [{ id: "unauthorized-task" }] })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Both proposals are approved." })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "What is the deadline?" })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Which tone should the welcome note and poster use?" })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Would you like the welcome note and poster to be formal?" })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Do you want the welcome note and poster by Friday?" })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Do you mean the welcome note or the poster?" })).not.toThrow();
    for (const reply of ["Which proposal do you mean?\n- Welcome note\n- Poster", "Which proposal do you mean?\n\n* Welcome note\n* Poster", "Which one\nshould I proceed with: the welcome note or poster?",
      "Should I proceed with the welcome note or the poster?", "Do you mean the note or the poster, or both?", "Should we start the poster or the welcome note, or both?", "Which garden-club item should we move forward with: the note or poster?",
      "Which pending proposal does yes approve?\n- Welcome note\n- Poster",
      "Which project(s) should I start on now?\n- Welcome note only\n- Poster only\n- Both",
      'There are two pending proposals: the **welcome note** and the **poster**. Your yes does not specify which. Could you clarify:\n\n- Just the welcome note?\n- Just the poster?\n- Both?\n\nI will record your decision.',
    ]) {
      expect(() => assertAmbiguousReplyUnresolved({ ...e, reply })).not.toThrow();
    }
  });
  it("accepts a current structured clarification and rejects stale or unrelated question cards", () => {
    const question = { id: "question", kind: "ask_user_questions", status: "pending", createdByAgentId: "planner",
      originCommentIds: ["ambiguous-answer"], payload: { questions: [{ prompt: "Which item(s) does go ahead authorize me to plan?", options: [{ label: "Welcome note only" }, { label: "Poster only" }] }] } };
    const evidence = { cards: [{ id: "a", status: "pending" }, { id: "b", status: "pending" }, question], originalIds: ["a", "b"], tasks: [], reply: "",
      agentId: "planner", answerId: "ambiguous-answer" };
    expect(() => assertAmbiguousReplyUnresolved(evidence)).not.toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...evidence, cards: [...evidence.cards.slice(0, 2), { ...question,
      payload: { questions: [{ prompt: "Which garden club item should I move forward with?", options: [{ label: "Welcome note" }, { label: "Poster" }] }] },
    }] })).not.toThrow();
    const native = { ...question, payload: { questionSet: { description: "Which item(s) would you like me to start developing a plan for?",
      questions: [{ prompt: "Scope", options: [{ label: "Welcome note only" }, { label: "Poster only" }, { label: "Both" }] }] } } };
    expect(() => assertAmbiguousReplyUnresolved({ ...evidence, cards: [...evidence.cards.slice(0, 2), native] })).not.toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...evidence, cards: [...evidence.cards.slice(0, 2), { ...native,
      payload: { questionSet: { ...native.payload.questionSet, description: "What is the deadline?" } },
    }] })).toThrow();
    for (const patch of [{ originCommentIds: ["old-answer"] }, { createdByAgentId: "other-agent" }, { status: "answered" }, { payload: { questions: [] } }, { payload: { questions: [{ prompt: "What is the deadline?" }] } }, { payload: { questions: [{ prompt: "Which tone should the welcome note and poster use?", options: [{ label: "Warm" }, { label: "Formal" }] }] } }]) {
      expect(() => assertAmbiguousReplyUnresolved({ ...evidence, cards: [...evidence.cards.slice(0, 2), { ...question, ...patch }] })).toThrow();
    }
  });
  it.each([
    "Which part of the welcome note or poster should I revise?",
    "Which font should I choose for the welcome note or poster?",
    "Which color option should the welcome note or poster use?",
    "Which of the fonts should I use for the welcome note or poster?",
    "Should I select a deadline for the welcome note or poster?",
    "Pick a font for the welcome note or poster?",
    "Would you like the welcome note or poster to be formal?",
    "Do you want the welcome note or poster by Friday?",
    "Could you clarify:\n- What font for the welcome note?\n- What font for the poster?",
  ])("does not mistake a detail question for proposal selection: %s", prompt => {
    const cards = [{ id: "a", status: "pending" }, { id: "b", status: "pending" }];
    const evidence = { cards, originalIds: ["a", "b"], tasks: [], reply: prompt, agentId: "planner", answerId: "answer" };
    expect(() => assertAmbiguousReplyUnresolved(evidence)).toThrow();
    // Named alternatives do not turn an unrelated field into a scope question.
    expect(() => assertAmbiguousReplyUnresolved({ ...evidence, reply: "", cards: [...cards, {
      id: "question", kind: "ask_user_questions", status: "pending", createdByAgentId: "planner", originCommentIds: ["answer"],
      payload: { questions: [{ prompt, options: [{ label: "Welcome note" }, { label: "Poster" }] }] },
    }] })).toThrow();
  });
  it.each(runnerMatrix.filter(e => e.suite.id === "confirmation-replies" && e.task.flow === "first_task"))("provisions the real onboarding fixture contract for $id", async execution => {
    const get = vi.fn().mockResolvedValue([{ id: "local", driver: "local" }]);
    const postSensitive = vi.fn().mockResolvedValue({ id: "secret" });
    const credential = execution.profile.credential;
    const fixtures = await provisionFirstTaskFixtures({ api: { get, postSensitive }, execution, nonce: "fixture",
      company: { id: "company", name: "Garden" }, credentials: { [credential]: "test-credential" } });
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/companies/company/environments?driver=local");
    expect(postSensitive).toHaveBeenCalledExactlyOnceWith("/api/companies/company/secrets", expect.objectContaining({ key: credential }));
    expect(fixtures.agent.id).toBe(""); // The real wizard must still create the agent.
    expect(JSON.stringify(fixtures)).not.toContain("test-credential");
  });
  it.each(["Select every proposal you want to approve.", "Choose the proposals to approve."])("accepts explicit proposal selection in an imperative form: %s", prompt => {
    expect(() => assertAmbiguousReplyUnresolved({ cards: [{ id: "a", status: "pending" }, { id: "b", status: "pending" },
      { id: "question", kind: "ask_user_questions", status: "pending", createdByAgentId: "agent", originCommentIds: ["reply"],
        payload: { questions: [{ prompt, options: [{ label: "Welcome note" }, { label: "Poster" }] }] } }],
      originalIds: ["a", "b"], tasks: [], reply: "", agentId: "agent", answerId: "reply" })).not.toThrow();
  });
  it("rejects an imperative about fonts even with named proposal options", () => {
    expect(() => assertAmbiguousReplyUnresolved({ cards: [{ id: "a", status: "pending" }, { id: "b", status: "pending" },
      { id: "question", kind: "ask_user_questions", status: "pending", createdByAgentId: "agent", originCommentIds: ["reply"],
        payload: { questions: [{ prompt: "Select every font you want to approve.", options: [{ label: "Welcome note" }, { label: "Poster" }] }] } }],
      originalIds: ["a", "b"], tasks: [], reply: "", agentId: "agent", answerId: "reply" })).toThrow();
  });

  it("selects exactly twelve explicit-only cases using production native profiles", () => {
    const cells = runnerMatrix.filter(e => e.suite.id === "confirmation-replies");
    expect(cells).toHaveLength(12);
    expect(new Set(cells.map(c => c.profile.id))).toEqual(new Set(["runner-codex", "runner-acpx-claude"]));
    expect(new Set(cells.map(c => c.task.id)).size).toBe(6);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "confirmation-replies"]))).toHaveLength(12);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === "confirmation-replies")).toBe(false);
  });
});


describe("unanswered question workflow oracle", () => {
  const good = () => ({
    original: { id: "color", status: "pending", payload: { questions: [{ options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }] }] } },
    afterMove: { id: "color", status: "pending", result: null, resolvedAt: null },
    afterAnswer: { id: "color", status: "answered", resolvedByUserId: "user", resolvedAt: "2026-09-01T12:02:00Z", result: { answers: [{ optionIds: ["blue"] }] } },
    unrelatedComment: { id: "unrelated-comment", authorUserId: "user", createdAt: "2026-09-01T12:00:00Z" },
    unrelatedReply: { id: "unrelated-reply", authorAgentId: "agent", body: "Paris.", createdAt: "2026-09-01T12:01:00Z" },
    lateReply: { id: "late-reply", authorAgentId: "agent", createdByRunId: "later-run", body: "Blue it is.", createdAt: "2026-09-01T12:03:00Z" }, taskCount: 0,
  });
  it("accepts the independently saved workflow", () => expect(gradeUnansweredQuestion(good()).every(check => check.passed)).toBe(true));
  it.each(["expired", "wrong-question", "missing-reply", "stale-reply", "wrong-answer", "missing-late-reply", "old-acknowledgement", "invented-work"])("rejects %s", kind => {
    const evidence: UnansweredQuestionEvidence = good();
    if (kind === "expired") evidence.afterMove.status = "expired";
    if (kind === "wrong-question") evidence.afterAnswer.id = "other-question";
    if (kind === "missing-reply") evidence.unrelatedReply = undefined;
    if (kind === "stale-reply") evidence.unrelatedReply!.createdAt = "2026-08-01T12:00:00Z";
    if (kind === "wrong-answer") evidence.afterAnswer.result.answers[0].optionIds = ["green"];
    if (kind === "missing-late-reply") evidence.lateReply = undefined;
    if (kind === "old-acknowledgement") evidence.lateReply!.createdAt = "2026-08-01T12:00:00Z";
    if (kind === "invented-work") evidence.taskCount = 1;
    expect(gradeUnansweredQuestion(evidence).some(check => !check.passed)).toBe(true);
  });
});
