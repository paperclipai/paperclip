import { expect, it } from "vitest";
import { linkedQuestionBinding } from "./chat-linked-question.js";
import { valid } from "./chat-linked-question.test-fixture.js";
import { grade_tasks } from "./chat-catalog-domains/internal-tasks.js";
import { createIssueThreadInteractionSchema } from "../../packages/shared/src/validators/issue.js";
it("accepts the actual public modern-question contract and its compatibility storage projection", () => {
  const input = valid();
  const parsed = createIssueThreadInteractionSchema.parse({ kind: "ask_user_questions", payload: input.interactions[0]!.payload });
  expect(parsed.kind).toBe("ask_user_questions");
  if (parsed.kind !== "ask_user_questions") throw new Error("Unexpected question contract");
  expect(parsed.payload.questions[0]?.id).toBe("which-task");
  input.interactions[0]!.payload = parsed.payload;
  expect(linkedQuestionBinding(input)?.questionId).toBe("which-task");
});
it("preserves original no-early-write, exact person selection, mutation actor and final link checks", () => {
  const input = valid(), binding = linkedQuestionBinding(input)!;
  const evidence = { text: binding.prompt, links: ["/RUN/issues/RUN-1", "/RUN/issues/experiment-task"] };
  const first = { ...input.observation, reply: evidence.text, links: evidence.links };
  const final = { ...structuredClone(input.observation), state: { ...input.observation.state, clarification: first },
    tasks: [{ ...input.observation.tasks[0]!, priority: "high" }, structuredClone(input.observation.tasks[1]!)],
    links: ["/RUN/issues/RUN-1"], activity: [{ id: "update", action: "issue.updated", entityId: "launch-task", agentId: "ceo" }] };
  expect(grade_tasks({ ...final, state: { ...final.state, clarification: { ...first, reply: "", links: [] } } }).passed).toBe(false);
  expect(grade_tasks(final).passed).toBe(true);
  const early = structuredClone(final); early.state.clarification.tasks[0]!.priority = "high";
  expect(grade_tasks(early).passed).toBe(false);
  const wrong = structuredClone(final); wrong.tasks[0]!.priority = "medium"; wrong.tasks[1]!.priority = "high";
  expect(grade_tasks(wrong).passed).toBe(false);
  const actor = structuredClone(final); actor.activity[0]!.agentId = "other";
  expect(grade_tasks(actor).passed).toBe(false);
  expect(grade_tasks({ ...final, links: [] }).passed).toBe(false);
});
it("grades the clarification by saved state and candidate links, not by its wording", () => {
  const input = valid();
  const first = { ...input.observation, reply: "There are two Landing page tasks: [Launch](/RUN/issues/RUN-1) and [Experiments](/RUN/issues/experiment-task). Tell me the one to raise to high.",
    links: ["/RUN/issues/RUN-1", "/RUN/issues/experiment-task"] };
  const final = { ...structuredClone(input.observation), state: { ...input.observation.state, clarification: first },
    tasks: [{ ...input.observation.tasks[0]!, priority: "high" }, structuredClone(input.observation.tasks[1]!)],
    links: ["/RUN/issues/RUN-1"], activity: [{ id: "update", action: "issue.updated", entityId: "launch-task", agentId: "ceo" }] };
  expect(grade_tasks(final).passed).toBe(true);
  const oneCandidate = structuredClone(final); oneCandidate.state.clarification.links = ["/RUN/issues/RUN-1"];
  expect(grade_tasks(oneCandidate).passed).toBe(false);
  const both = structuredClone(final); both.tasks[1]!.priority = "high";
  expect(grade_tasks(both).passed).toBe(false);
});
// Full cohort 11: the question card had no linked context; its options named each candidate with its path as
// plain text. Choice options render inside radio buttons, which cannot hold links, so the saved options are graded.
it("accepts a saved question card that offers each candidate as its own choice, and rejects one that does not", () => {
  const input = valid();
  const card = (options: Array<{ id: string; label: string; description?: string }>, sourceRunId = "run") => ({ ...structuredClone(input.interactions[0]!), sourceRunId,
    payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "task_choice", prompt: "Which landing-page task should become high priority?", answerMode: "single_select", required: true, options }] } } });
  const retained = [{ id: "com1", label: "RUN-1 (Launch project)", description: "Landing page task RUN-1 in the Launch project: /RUN/issues/RUN-1" },
    { id: "com2", label: "RUN-2 (Experiments project)", description: "Landing page task RUN-2 in the Experiments project: /RUN/issues/RUN-2" },
    { id: "both", label: "Both", description: "Mark both landing-page tasks as high priority: /RUN/issues/RUN-1 and /RUN/issues/RUN-2" }];
  const graded = (questionCards: unknown[]) => {
    const first = { ...input.observation, reply: "", links: [], questionCards };
    return grade_tasks({ ...structuredClone(input.observation), state: { ...input.observation.state, clarification: first },
      tasks: [{ ...input.observation.tasks[0]!, priority: "high" }, structuredClone(input.observation.tasks[1]!)],
      links: ["/RUN/issues/RUN-1"], activity: [{ id: "update", action: "issue.updated", entityId: "launch-task", agentId: "ceo" }] }).passed;
  };
  expect(graded([card(retained)])).toBe(true);
  expect(graded([card([{ id: "a", label: "Launch", description: "The RUN-1 task" }, { id: "b", label: "Experiments", description: "The RUN-2 task" }])])).toBe(true);
  expect(graded([])).toBe(false);
  expect(graded([card([retained[0]!, retained[2]!])])).toBe(false);
  expect(graded([card([{ id: "a", label: "Launch" }, { id: "b", label: "Experiments" }])])).toBe(false);
  expect(graded([card([retained[0]!, { id: "c", label: "RUN-12 (Archive)" }])])).toBe(false);
  expect(graded([card(retained, "other-run")])).toBe(false);
  for (const withdrawn of [{ status: "cancelled" }, { status: "expired" }, { dismissedAt: "2026-10-28T12:00:45Z" }, { resolvedAt: "2026-10-28T12:00:45Z" }]) {
    expect(graded([{ ...card(retained), ...withdrawn }]), JSON.stringify(withdrawn)).toBe(false);
  }
});
