// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linkedQuestionBinding, readLinkedQuestionDom } from "./chat-linked-question.js";
import { valid, dom, type Input } from "./chat-linked-question.test-fixture.js";

beforeEach(() => { document.body.innerHTML = dom(); vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList); });
afterEach(() => vi.restoreAllMocks());
const collect = (input = valid()) => { const bound = linkedQuestionBinding(input); return bound && readLinkedQuestionDom(bound); };
it("collects an actual production question takeover's two visible saved-task links with no ordinary reply", () => {
  expect(document.querySelectorAll('[id^="comment-"] a')).toHaveLength(0);
  const evidence = collect();
  expect(evidence?.links).toEqual(["/RUN/issues/RUN-1", "/RUN/issues/experiment-task"]);
  expect(evidence?.text).toBe("Which Landing page task should be High priority?");
  expect(evidence).toMatchObject({ interactionId: "question", questionId: "which-task", anchorCommentId: "human", sourceRunId: "run", leadId: "ceo" });
});
it("keeps supported unprefixed issue hrefs with exact saved identities and current company page binding", () => {
  const input = valid();
  input.interactions[0]!.payload.questionSet!.description = "Choose [Launch](/issues/launch-task) or [Experiments](/issues/experiment-task).";
  const anchors = document.querySelectorAll("a");
  anchors[0]!.setAttribute("href", "/issues/launch-task"); anchors[1]!.setAttribute("href", "/issues/experiment-task");
  expect(collect(input)?.links).toEqual(["/issues/launch-task", "/issues/experiment-task"]);
  for (const pageUrl of ["https://fixture.test/OTHER/chats/ceo", "https://foreign.test/RUN/chats/ceo", "https://fixture.test/chats/ceo"]) {
    input.pageUrl = pageUrl; expect(collect(input)).toBeUndefined();
  }
});
it.each([
  "Choose [Launch][launch] or [Experiments][experiments].\n\n[launch]: /RUN/issues/RUN-1\n[experiments]: /RUN/issues/experiment-task",
  "Choose [Launch](/RUN/issues/RUN-1) or [Experiments](/RUN/issues/experiment-task). Context: [Launch project](/RUN/projects/launch).",
])("reads actual rendered task hrefs without a second Markdown spelling or context policy: %s", description => {
  const input = valid(); input.interactions[0]!.payload.questionSet!.description = description;
  document.querySelector('[aria-label="Question context"]')!.insertAdjacentHTML("beforeend", '<a href="/RUN/projects/launch">Launch project</a><a href="https://docs.example.test/context">Context</a>');
  expect(collect(input)?.links).toEqual(["/RUN/issues/RUN-1", "/RUN/issues/experiment-task"]);
});
it.each([
  ["wrong company", (v: Input) => { v.interactions[0]!.companyId = "foreign"; }],
  ["wrong conversation", (v: Input) => { v.interactions[0]!.issueId = "other-source"; }],
  ["wrong CEO", (v: Input) => { v.interactions[0]!.createdByAgentId = "another-agent"; }],
  ["human-created card", (v: Input) => { v.interactions[0]!.createdByUserId = "person"; }],
  ["wrong run", (v: Input) => { v.interactions[0]!.sourceRunId = "old-run"; }],
  ["stale card", (v: Input) => { v.interactions[0]!.createdAt = "2026-10-27T12:00:00Z"; }],
  ["future card", (v: Input) => { v.interactions[0]!.createdAt = "2026-10-29T12:00:00Z"; }],
  ["resolved card", (v: Input) => { v.interactions[0]!.status = "accepted"; }],
  ["dismissed card", (v: Input) => { v.interactions[0]!.dismissedAt = "2026-10-28T12:00:40Z"; }],
  ["wrong addressed person", (v: Input) => { v.interactions[0]!.addresseeUserId = "other"; }],
  ["agent addressed", (v: Input) => { v.interactions[0]!.addresseeAgentId = "ceo"; }],
  ["invalid resolver", (v: Input) => { v.interactions[0]!.effectiveResolverPolicy = "invalid" as never; }],
  ["wrong origin question", (v: Input) => { v.interactions[0]!.originCommentIds = ["old-human"]; }],
  ["foreign origin comment", (v: Input) => { v.interactions[0]!.originCommentIds!.push("foreign-comment"); }],
  ["wrong source comment", (v: Input) => { v.interactions[0]!.sourceCommentId = "other-human"; }],
  ["missing create action", (v: Input) => { v.observation.activity = []; }],
  ["wrong create actor", (v: Input) => { v.observation.activity[0]!.actorId = "other"; }],
  ["wrong create company", (v: Input) => { v.observation.activity[0]!.companyId = "foreign"; }],
  ["wrong action run", (v: Input) => { Object.assign(v.observation.activity[0]!, { runId: "old-run" }); }],
  ["wrong action resource kind", (v: Input) => { Object.assign(v.observation.activity[0]!, { entityType: "project" }); }],
  ["wrong action question", (v: Input) => { v.observation.activity[0]!.details!.interactionId = "other"; }],
  ["wrong action kind", (v: Input) => { v.observation.activity[0]!.details!.interactionKind = "request_confirmation"; }],
  ["legacy run", (v: Input) => { v.observation.runs[0]!.runtimeMode = "legacy"; }],
  ["unrelated run issue", (v: Input) => { v.observation.runs[0]!.contextSnapshot = { issueId: "other" }; }],
  ["foreign saved task", (v: Input) => { v.tasks[0]!.companyId = "foreign"; }],
  ["wrong actual task", (v: Input) => { v.observation.tasks[0]!.id = "other"; }],
  ["duplicate saved task", (v: Input) => { v.tasks[1] = v.tasks[0]!; }],
  ["old human request", (v: Input) => { v.comments[0]!.body = "another query"; }],
  ["nonhuman original request", (v: Input) => { v.comments[0]!.authorAgentId = "ceo"; }],
  ["missing linked context", (v: Input) => { v.interactions[0]!.payload.questionSet!.description = ""; }],
  ["another native action", (v: Input) => { v.interactions.push(structuredClone(v.interactions[0]!)); }],
] as const)("rejects %s metadata rather than any question-card presence", (_, change) => {
  const input = valid(); change(input); expect(collect(input)).toBeUndefined();
});
it.each([
  ["foreign company", "/OTHER/issues/RUN-1"], ["foreign origin", "https://foreign.test/RUN/issues/RUN-1"], ["wrong task", "/RUN/issues/wrong"],
  ["task search", "/RUN/issues?search=RUN-1"], ["fragment", "/RUN/issues/RUN-1#unrelated"],
] as const)("rejects %s saved question link", (_, href) => {
  const input = valid(); input.interactions[0]!.payload.questionSet!.description = input.interactions[0]!.payload.questionSet!.description!.replace("/RUN/issues/RUN-1", href);
  document.querySelector("a")!.setAttribute("href", href);
  expect(collect(input)).toBeUndefined();
});
const domNegatives: Array<[string, () => void]> = [
  ["missing exact interaction", () => document.querySelector("button")!.id = "interaction-other"],
  ["wrong visible question", () => document.querySelector("p")!.textContent = "Another question?"],
  ["wrong question binding", () => document.querySelector("p")!.id = "question-other-prompt"],
  ["hidden takeover", () => document.querySelector("section")!.hidden = true],
  ["hidden prompt", () => document.querySelector("p")!.setAttribute("aria-hidden", "true")],
  ["hidden linked task", () => document.querySelector("a")!.setAttribute("style", "display:none")],
  ["no actual context links", () => document.querySelectorAll("a").forEach(node => node.remove())],
  ["wrong DOM link", () => document.querySelector("a")!.setAttribute("href", "/RUN/issues/wrong")],
  ["sidebar link only", () => document.body.append(document.querySelector("a")!)],
  ["unrelated conversation", () => document.querySelector("main")!.querySelector("#comment-human")!.remove()],
  ["ambiguous conversation", () => document.body.insertAdjacentHTML("beforeend", dom())],
  ["unrelated takeover", () => document.querySelector("section")!.setAttribute("data-testid", "another-takeover")],
];
it.each(domNegatives)("rejects %s DOM evidence", (_, change) => {
  change();
  expect(collect()).toBeUndefined();
});
