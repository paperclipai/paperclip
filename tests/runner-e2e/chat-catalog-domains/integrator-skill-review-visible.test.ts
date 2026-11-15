// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readVisibleSkillReview, waitForVisibleSkillReview, collectVisibleSkillReviewFallback } from "./integrator-skill-update.js";
const input = { runId: "run", humanCommentId: "human" };
const thread = (body: string) => `<section data-testid="task-chat-thread"><div id="comment-human">Review before updating.</div>${body}</section>`;
const response = '<div data-thread-anchor="run:turn:0"><div data-testid="task-chat-final-response"><strong>Installed 0.4</strong><p>Regression tests; split forms into smaller steps. No update applied yet.</p></div></div>';
beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  // jsdom does not implement rendered innerText; the browser collector uses the real property.
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent ?? ""; } });
  document.body.innerHTML = thread(response);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("reads rendered current completion only, excluding reasoning and tool output", () => {
  document.querySelector('[data-thread-anchor]')!.insertAdjacentHTML("afterbegin", '<div data-testid="task-chat-reasoning">PRIVATE REASONING</div><pre>TOOL STDOUT</pre>');
  expect(readVisibleSkillReview(input)).toContain("Installed 0.4");
  expect(readVisibleSkillReview(input)).not.toMatch(/PRIVATE|STDOUT|<strong>/);
});
it("rejects hidden, foreign, old and ambiguously anchored conversation surfaces", () => {
  for (const body of [response.replace('run:turn:0', 'old:turn:0'), response.replace('<div data-testid="task-chat-final-response"', '<div hidden data-testid="task-chat-final-response"')]) {
    document.body.innerHTML = thread(body); expect(readVisibleSkillReview(input)).toBe("");
  }
  document.body.innerHTML = thread(response).replace('comment-human', 'comment-foreign'); expect(readVisibleSkillReview(input)).toBe("");
  document.body.innerHTML = thread(response) + thread(response); expect(readVisibleSkillReview(input)).toBe("");
});

it("waits for eventual current response hydration within the original deadline only", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  document.body.innerHTML = thread("");
  const evaluate = vi.fn(async () => readVisibleSkillReview(input));
  const ctx = { observationDeadlineAt: 2_000, input: { page: { evaluate } } } as unknown as Parameters<typeof waitForVisibleSkillReview>[0];
  const summary = "Installed 0.4. Regression tests and forms split into small steps.";
  const base = { reply: "See the complete diff above. No update applied yet.", companyId: "company", leadId: "ceo",
    runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", nativeIssueId: "source",
      contextSnapshot: { issueId: "source", commentId: "human" }, resultJson: { summary, finalizationPhase: "committed", finalizationReasonCode: "conversation_turn_finished",
        prpRunTerminalState: "succeeded", prpTurnTerminalState: "completed", nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary } } }] } as unknown as Parameters<typeof collectVisibleSkillReviewFallback>[1];
  const pending = collectVisibleSkillReviewFallback(ctx, base, "source");
  await vi.advanceTimersByTimeAsync(250);
  document.body.innerHTML = thread(response);
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending)?.visibleText).toContain("Installed 0.4");
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(ctx.observationDeadlineAt).toBe(2_000);
  document.body.innerHTML = thread(response.replace('run:turn:0', 'foreign:turn:0'));
  const timeout = expect(waitForVisibleSkillReview(ctx, input)).rejects.toThrow("Timed out waiting");
  await vi.advanceTimersByTimeAsync(500); await timeout;
  expect(ctx.observationDeadlineAt).toBe(2_000);
  await expect(waitForVisibleSkillReview(ctx, input)).rejects.toThrow("budget exhausted");
});
