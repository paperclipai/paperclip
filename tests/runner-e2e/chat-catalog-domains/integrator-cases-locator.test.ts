// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@playwright/test", () => ({ expect: vi.fn() }));
import { gradeIntegratorCases, unansweredQuestionSelector } from "./integrator-cases.js";
afterEach(() => { document.body.innerHTML = ""; });
const chip = (id: string, attrs = "") => `<button type="button" id="interaction-${id}" ${attrs} data-testid="task-chat-unanswered-question" aria-label="Answer question: How should I track this bug?">Unanswered question</button>`;
// Full cohort 11: the chip and the docked takeover card both carried id="interaction-<id>", so the
// bare id locator hit Playwright strict mode. The chip selector must resolve to the chip alone.
it("selects only the timeline chip when the docked card shares its interaction", () => {
  for (const takeover of [
    `<div class="tc-enter-bubble w-full" data-testid="task-chat-interaction" id="interaction-question">Question card</div>`,
    `<section data-testid="task-chat-composer-takeover"><div data-interaction-id="question" data-testid="task-chat-interaction">Question card</div></section>`,
  ]) {
    document.body.innerHTML = `${chip("question", 'data-interaction-id="question"')}${takeover}${chip("other")}`;
    const selected = document.querySelectorAll(unansweredQuestionSelector("question"));
    expect(selected).toHaveLength(1);
    expect(selected[0]!.tagName).toBe("BUTTON");
  }
  expect(document.querySelectorAll(unansweredQuestionSelector("missing"))).toHaveLength(0);
});
it("grades the disabled-Cases choice card on its saved options, not its wording", () => {
  const base = { scenarioId: "cases.cases-disabled", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: {}, tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [],
    runs: [{ id: "run", agentId: "ceo", status: "succeeded" }], casesEnabled: false, casesReadStatus: 403, casesReadError: "Cases are disabled", cases: [], links: [], reply: "" };
  const card = (options: number) => ({ id: "question", kind: "ask_user_questions", status: "pending",
    payload: { questions: [{ id: "q", prompt: "Cases are turned off on this instance. How should I track the checkout bug?", options: Array.from({ length: options }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) }] } });
  expect(gradeIntegratorCases({ ...base, interactions: [card(2)] }).passed).toBe(true);
  expect(gradeIntegratorCases({ ...base, interactions: [card(1)] }).passed).toBe(false);
  expect(gradeIntegratorCases({ ...base, interactions: [{ ...card(2), status: "answered" }] }).passed).toBe(false);
});
