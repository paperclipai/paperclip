// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readVisibleSkillReview } from "./integrator-skill-update.js";
const input = { runId: "run", humanCommentId: "human" };
const thread = (body: string) => `<section data-testid="task-chat-thread"><div id="comment-human">Review before updating.</div>${body}</section>`;
const response = '<div data-thread-anchor="run:turn:0"><div data-testid="task-chat-final-response"><strong>Installed 0.4</strong><p>Regression tests; split forms into smaller steps. No update applied yet.</p></div></div>';
beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  // jsdom does not implement rendered innerText; the browser collector uses the real property.
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent ?? ""; } });
  document.body.innerHTML = thread(response);
});
afterEach(() => vi.restoreAllMocks());
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
