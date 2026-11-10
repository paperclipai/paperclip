import { expect, it, vi } from "vitest";
vi.mock("@playwright/test", () => ({ expect: (target: { isDisabled?: () => boolean; isVisible?: () => boolean }) => ({
  toBeDisabled: async () => { if (!target.isDisabled?.()) throw new Error("Expected actual disabled Next"); },
  toBeVisible: async () => { if (!target.isVisible?.()) throw new Error("Expected current first question visible"); },
}) }));
import { questionIdentityCases } from "./chat-catalog-domains/identity-questions-and-approvals.js";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
function fixture(options: { advancesMissing?: boolean; missingValidation?: boolean; createsWork?: boolean; resumesWork?: boolean; wrongPrompt?: boolean; changedPayload?: boolean; prematurelyResolved?: boolean } = {}) {
  let page = 0, answered = false, reads = 0, submitted = false, attemptedMissing = false;
  const clicks: string[] = [], answers: Record<string, string> = {};
  const original = { id: "question", companyId: "company", issueId: "source", kind: "ask_user_questions", status: "pending", payload: { questionSet: { questions: [
    { id: "audience", prompt: "Who is the audience?", required: true }, { id: "tone", prompt: "What tone should we use?", required: true }, { id: "headline", prompt: "What is your custom headline?", required: true },
  ] } } };
  const form: any = { isVisible: () => true, getByText: (prompt: string) => ({ isVisible: () => prompt === "This question is required."
    ? attemptedMissing && !options.missingValidation : !options.wrongPrompt && prompt === original.payload.questionSet.questions[page]?.prompt }),
    getByRole: (_role: string, { name }: { name: string | RegExp }) => ({
      isDisabled: () => false,
      isChecked: () => answers.audience === "Researchers",
      click: async () => { const label = String(name); clicks.push(label);
        if (label === "Next") { if (!answered) { attemptedMissing = true; if (options.advancesMissing) page++; return; } page++; answered = !!answers[original.payload.questionSet.questions[page]?.id ?? ""]; }
        else if (label === "Previous question") { page--; answered = !!answers[original.payload.questionSet.questions[page]!.id]; }
        else if (label === "Researchers" || label === "Clear") { answers[original.payload.questionSet.questions[page]!.id] = label; answered = true; }
        else { if (page !== 2 || !answers.headline) throw new Error("Cannot submit incomplete questions"); submitted = true; }
      },
    }),
    getByTestId: () => ({ isVisible: async () => page === 2, locator: () => ({ first: () => ({ fill: async (value: string) => { answers.headline = value; } }) }) }),
  };
  const query = "Help me choose the details for the launch page before you build it.";
  const ctx = { observationDeadlineAt: Date.now() + 300_000, scenario: { query }, issue: () => ({ id: "source", conversationState: "waiting" }), refreshIssue: async () => {}, allRuns: async () => [{ id: "native", companyId: "company", agentId: "ceo", contextSnapshot: { issueId: "source", commentId: "human" }, status: "succeeded" }, ...(options.resumesWork && attemptedMissing ? [{ id: "forbidden-continuation", status: "running" }] : [])],
    input: { fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, page: { locator: () => ({ click: async () => {} }), getByTestId: () => form }, api: { get: async (url: string) => {
      if (url.endsWith("comments?order=asc")) return [{ id: "human", issueId: "source", authorUserId: "person", body: query }];
      if (url.endsWith("interactions")) { reads++; return [{ ...original, status: options.prematurelyResolved ? "resolved" : "pending", payload: options.changedPayload && reads >= 2 ? { replaced: true } : original.payload }]; }
      return options.createsWork && attemptedMissing && url.includes("/issues?") ? [{ id: "forbidden-work" }] : [];
    } } },
  } as unknown as ChatCatalogContext;
  return { ctx, state: { sourceId: "source", original, answer: "Acorn unchanged human answer" } as Record<string, unknown>, clicks, answers, submitted: () => submitted };
}
it("actual multipart act clicks enabled Next to observe required blocking, retains earlier choice and submits the exact supplied answer", async () => {
  const f = fixture(), c = questionIdentityCases.find(row => row.scenarioId === "questions-and-approvals.multi-part-question")!;
  await c.act!(f.ctx, f.state);
  expect(f.state.validationObserved).toBe(true); expect(f.state.retainedAudience).toBe(true); expect(f.state.unsubmittedPending).toBe(true);
  expect(f.clicks).toEqual(["Next", "Researchers", "Next", "Previous question", "Next", "Clear", "Next", "/^(Submit|Send) answers$/"]);
  expect(f.answers).toEqual({ audience: "Researchers", tone: "Clear", headline: "Acorn unchanged human answer" }); expect(f.submitted()).toBe(true);
});
it.each([{ advancesMissing: true }, { missingValidation: true }, { createsWork: true }, { resumesWork: true }, { wrongPrompt: true }, { changedPayload: true }, { prematurelyResolved: true }])("rejects invalid current required-question proof %j before any answer", async options => {
  const f = fixture(options), c = questionIdentityCases.find(row => row.scenarioId === "questions-and-approvals.multi-part-question")!;
  await expect(c.act!(f.ctx, f.state)).rejects.toThrow(); expect(f.clicks.every(click => click === "Next")).toBe(true); expect(f.answers).toEqual({}); expect(f.submitted()).toBe(false);
});
