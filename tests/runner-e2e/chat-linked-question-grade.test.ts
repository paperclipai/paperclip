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
