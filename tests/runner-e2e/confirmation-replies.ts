import { expect, type Page } from "@playwright/test";
import { createIssueThreadInteractionSchema } from "../../packages/shared/src/validators/issue.js";
import type { FirstTaskEvidence, FirstTaskCheck, Row } from "./first-task-scoring.js";
import { firstTaskScenario } from "./first-task-cases.js";
import { sendChatMessage, type ChatFlowInput, type ChatIssue } from "./chat-flow.js";

// Validate public fixture requests before spending provider turns. The selected
// checkbox default deliberately proves that a default is not user consent.
export const ambiguousConfirmationFixtures = [
  createIssueThreadInteractionSchema.parse({ kind: "request_confirmation", title: "Welcome note proposal", continuationPolicy: "none", payload: { version: 1, prompt: "Approve writing the welcome note?" } }),
  createIssueThreadInteractionSchema.parse({ kind: "request_checkbox_confirmation", title: "Poster proposal", continuationPolicy: "none", payload: { version: 1, prompt: "Approve the poster?", options: [{ id: "poster", label: "Create a garden club poster" }], defaultSelectedOptionIds: ["poster"], minSelected: 1 } }),
];

/** Check the saved user-facing receipt, including its original proposal. */
export async function assertConfirmationReceipt(page: Page, card: Row) {
  expect(["accepted", "rejected"]).toContain(card.status);
  const receipt = page.getByTestId("task-chat-interaction-receipt").filter({ hasText: card.payload.prompt });
  const summary = card.status === "accepted"
    ? card.kind === "request_confirmation" ? "Confirmed request"
      : `Confirmed ${card.result.selectedOptionIds.length} of ${card.payload.options.length} options`
    : card.kind === "request_checkbox_confirmation" ? "Declined selection"
      : card.payload.rejectLabel?.trim() ? `Selected “${card.payload.rejectLabel.trim()}”` : "Declined request";
  await expect(receipt.locator("summary")).toHaveText(summary);
  await receipt.locator("summary").click();
  await expect(receipt.getByText(card.payload.prompt, { exact: true })).toBeVisible();
  if (card.kind === "request_checkbox_confirmation" && card.status === "accepted") {
    for (const option of card.payload.options.filter((option: Row) => card.result.selectedOptionIds.includes(option.id))) {
      await expect(receipt).toContainText(option.label);
    }
  }
}

/** The independent oracle checks recorded card state, provenance and ordering, not agent claims. */
export function gradeConfirmationReply(e: FirstTaskEvidence): FirstTaskCheck[] {
  const expected = e.caseId === "reject-no-execution" ? "rejected" : "accepted";
  const decision = e.checkpoints.find(c => c.phase === expected);
  const last = e.checkpoints.at(-1);
  const scenario = firstTaskScenario(e.caseId, e.nonce);
  const reply = decision?.comments.find(c => !c.authorAgentId && c.authorUserId && c.body === (expected === "accepted" ? scenario.acceptance : scenario.rejection));
  const before = e.checkpoints.filter(c => ["response", "clarified", "revised"].includes(c.phase)).at(-1);
  const pending = before?.interactions.filter(c => c.status === "pending" && ["request_confirmation", "request_checkbox_confirmation"].includes(c.kind)) ?? [];
  const card = pending.length === 1 ? last?.interactions.find(c => c.id === pending[0]!.id) : undefined;
  const resolvedAt = Date.parse(card?.resolvedAt ?? "");
  const run = last?.runs.find(r => r.id === card?.resolvedByRunId);
  const valid = Boolean(reply && card && card.status === expected && card.result?.outcome === expected
    && card.result?.commentId === reply.id && card.resolvedByAgentId === e.agentId && run?.agentId === e.agentId
    && Number.isFinite(resolvedAt) && resolvedAt >= Date.parse(reply.createdAt ?? decision!.at)
    && (card.kind !== "request_checkbox_confirmation" || expected === "rejected" || Array.isArray(card.result?.selectedOptionIds)));
  const children = last?.tasks.filter(t => !e.initialTaskIds.includes(t.id) && t.id !== e.onboardingIssueId) ?? [];
  return [{ id: "conversation-resolves-confirmation", passed: valid,
    evidence: [before?.id, decision?.id, last?.id].filter((v): v is string => Boolean(v)),
    detail: "The exact pending proposal records the user's reply and the resolving agent run as an accepted/rejected outcome" },
  { id: "resolution-before-execution", passed: valid && children.every(t => Date.parse(t.createdAt ?? "") >= resolvedAt),
    evidence: last ? [last.id] : [], detail: "Structured approval is persisted before any child task is created" }];
}

// This fixture asks the user to choose between two named proposals. A question
// about tone, deadline, or another detail does not disambiguate that approval.
function asksWhichProposal(body: string, options: string[] = []): boolean {
  const text = body.replace(/^(\s*)\*\s/gm, "$1- ").replace(/[*_`]/g, "");
  // Keep the interrogative's object explicit. Arbitrary intervening words (or
  // bare "of") also match "which part of" and "which font option", which ask
  // about details rather than choosing a proposal. "Garden club" is this
  // fixture's named scope, not a wildcard for any modifier.
  const scopedChoice = /\bwhich\s+(?:(?:pending|current|proposed|available|separate|two)\s+|garden[\s-]+club\s+)?(?:one|ones|item|items|proposal|proposals|project|projects|task|tasks|option|options)\b/i;
  // Structured forms can ask imperatively, without a question mark. Require
  // both named alternatives plus an explicit proposal-selection instruction.
  const namedOptions = options.some(option => /\b(?:welcome\s+)?note\b/i.test(option))
    && options.some(option => /\bposter\b/i.test(option));
  if (namedOptions && /\b(?:select|choose|pick)\s+(?:(?:all|every|each|one|the|any)(?:\s+of\s+the)?\s+)?proposals?\s+(?:you\s+(?:want|wish)\s+to\s+|to\s+)?(?:approve|authorize)\b/i.test(text)) return true;
  const proposalName = "(?:the\\s+)?(?:(?:welcome\\s+)?note|poster)(?:\\s+proposal)?";
  const choiceIntent = "(?:(?:do|did|would)\\s+you\\s+(?:mean|want|prefer|like)|should\\s+(?:i|we)\\s+(?:start|proceed\\s+with))";
  const directChoice = new RegExp(`\\b${choiceIntent}\\s+${proposalName}\\s+or\\s+${proposalName}(?:,?\\s+or\\s+both)?\\s*\\?`, "i");
  const clarificationList = text.match(/\b(?:could|can|would)\s+you\s+(?:please\s+)?clarify\s*:\s*\n((?:\s*[-+]\s+(?:just\s+)?(?:the\s+)?(?:(?:welcome\s+)?note|poster|both)(?:\s+only)?\??[ \t]*(?:\n|$)){2,})/i)?.[1];
  if (clarificationList && /\bnote\b/i.test(clarificationList) && /\bposter\b/i.test(clarificationList)) return true;
  return [...text.matchAll(/[^?]*\?/g)].some(match => {
    const question = match[0];
    const listedOptions: string[] = [];
    for (const line of text.slice(match.index! + question.length).trimStart().split("\n")) {
      const item = line.match(/^\s*(?:[-+]|\d+[.)])\s+(.+)$/);
      if (!item) break;
      listedOptions.push(item[1]!);
    }
    const choices = [...options, ...listedOptions];
    const alternatives = [question, ...choices].join(" ");
    const namesBoth = /\b(?:welcome\s+)?note\b/i.test(alternatives) && /\bposter\b/i.test(alternatives);
    const choosesNamedScope = scopedChoice.test(question);
    return namesBoth && (choosesNamedScope || directChoice.test(question));
  });
}

type AmbiguousReplyEvidence = { cards: Row[]; originalIds: string[]; tasks: Row[]; reply: string; agentId?: string; answerId?: string };
function assertAmbiguousStateUnchanged(input: AmbiguousReplyEvidence) {
  expect(input.originalIds).toHaveLength(2);
  expect(input.cards.filter(c => input.originalIds.includes(c.id)).map(c => c.status)).toEqual(["pending", "pending"]);
  expect(input.tasks).toHaveLength(0);
}
export function assertAmbiguousReplyUnresolved(input: AmbiguousReplyEvidence) {
  assertAmbiguousStateUnchanged(input);
  const questionCard = input.cards.some(card => card.kind === "ask_user_questions" && card.status === "pending"
    && input.agentId && card.createdByAgentId === input.agentId && input.answerId && card.originCommentIds?.includes(input.answerId)
    && (card.payload?.questionSet?.questions ?? card.payload?.questions ?? []).some((question: Row) => asksWhichProposal(
      [card.payload?.questionSet?.description, question.prompt].filter(Boolean).join("\n"),
      (question.options ?? []).map((option: Row) => option.label ?? ""))));
  expect(asksWhichProposal(input.reply) || questionCard, "Ask which proposal the ambiguous reply refers to").toBe(true);
}

export async function runAmbiguousConfirmationReply(context: {
  input: ChatFlowInput; issue(): ChatIssue; idle(count: number): Promise<void>; comments(): Promise<Row[]>;
}) {
  const { input } = context;
  const { api, page } = input;
  await sendChatMessage(page, "I am considering a welcome note and a poster for our garden club. Neither is approved. Just acknowledge for now; do not create tasks or start either one.");
  await context.idle(1);
  const issue = context.issue();
  const cardsPath = `/api/issues/${issue.id}/interactions`;
  // Public board-created cards of different kinds retain independent pending
  // decisions, rather than depending on a model producing two simultaneous tools.
  const note = await api.post<Row>(cardsPath, ambiguousConfirmationFixtures[0]);
  const poster = await api.post<Row>(cardsPath, ambiguousConfirmationFixtures[1]);
  const before = await api.get<Row[]>(cardsPath);
  expect(before.filter(c => c.status === "pending").map(c => c.id).sort()).toEqual([note.id, poster.id].sort());
  await input.evidence("confirmation-before-reply.json", { issueId: issue.id, cards: before });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-chat-composer-takeover")).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-takeover")).toContainText("Approve");
  await input.capture("confirmation-pending", "Two independent pending proposals", "confirmation-pending.png");
  await sendChatMessage(page, "Yes, go ahead.");
  await context.idle(2);
  const afterReply = await context.comments();
  const ambiguousAnswer = afterReply.findLast(c => !c.authorAgentId && c.authorUserId && c.body === "Yes, go ahead.");
  expect(ambiguousAnswer, "Persist the exact ambiguous user reply").toBeTruthy();
  const e = { cards: await api.get<Row[]>(cardsPath), originalIds: [note.id, poster.id],
    tasks: await api.get<Row[]>(`/api/companies/${input.fixtures.company.id}/issues`),
    agentId: input.fixtures.agent.id, answerId: ambiguousAnswer!.id,
    reply: afterReply.filter(c => c.authorAgentId === input.fixtures.agent.id && c.createdAt >= ambiguousAnswer!.createdAt).at(-1)?.body ?? "" };
  await input.evidence("confirmation-ambiguous.json", e);
  // Stop immediately for unauthorized effects. Retain the complete later
  // decision/reload evidence before grading clarification wording: a new valid
  // wording must not force another paid run just to observe those later steps.
  assertAmbiguousStateUnchanged(e);
  await sendChatMessage(page, "I approve only the welcome note proposal. Record that decision, but do not start execution or create a task yet. Leave the poster proposal pending.");
  await context.idle(3);
  let cards = await api.get<Row[]>(cardsPath);
  const yes = (await context.comments()).filter(c => !c.authorAgentId && c.body.includes("I approve only")).at(-1)!;
  expect(cards.find(c => c.id === note.id)).toMatchObject({ status: "accepted", result: { commentId: yes.id } });
  expect(cards.find(c => c.id === poster.id)?.status).toBe("pending");
  await sendChatMessage(page, "No, do not proceed with the poster. Reject that proposal. We are still not starting any work.");
  await context.idle(4);
  cards = await api.get<Row[]>(cardsPath);
  const no = (await context.comments()).filter(c => !c.authorAgentId && c.body.includes("No, do not proceed")).at(-1)!;
  expect(cards.find(c => c.id === poster.id)).toMatchObject({ status: "rejected", result: { commentId: no.id } });
  expect(await api.get<Row[]>(`/api/companies/${input.fixtures.company.id}/issues`)).toHaveLength(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (const id of [note.id, poster.id]) {
    await assertConfirmationReceipt(page, cards.find(card => card.id === id)!);
  }
  await input.evidence("confirmation-decisions.json", { cards, comments: await context.comments(), activity: await api.get(`/api/issues/${issue.id}/activity`) });
  await input.capture("confirmation-decisions", "Conversational approval and rejection persisted", "confirmation-decisions.png");
  input.check?.("confirmation-decisions-persisted", true, "Exact user comments resolve the chosen cards; reloaded receipts show approval and rejection, with no tasks created");
  assertAmbiguousReplyUnresolved(e);
  input.check?.("ambiguous-approval-not-assumed", true, "The agent asks which proposal is intended and leaves both decisions pending until explicitly answered");
}

export interface UnansweredQuestionEvidence {
  original: Row;
  afterMove: Row;
  afterAnswer: Row;
  unrelatedComment: Row | undefined;
  unrelatedReply: Row | undefined;
  lateReply: Row | undefined;
  taskCount: number;
}
export function gradeUnansweredQuestion(e: UnansweredQuestionEvidence) {
  const originalOptions: Row[] = (e.original.payload?.questionSet?.questions ?? e.original.payload?.questions ?? [])[0]?.options ?? [];
  const blueId = originalOptions.find(option => option.label.toLowerCase() === "blue")?.id;
  const answer = e.afterAnswer.result?.answers?.[0];
  return [
    { id: "unanswered-preserved", passed: Boolean(e.original.id && e.afterMove.id === e.original.id && e.original.status === "pending"
      && e.afterMove.status === "pending" && !e.afterMove.result && !e.afterMove.resolvedAt), detail: "Moving on preserves the exact unanswered question without inventing a resolution" },
    { id: "unrelated-turn-completed", passed: Boolean(e.unrelatedComment?.authorUserId && e.unrelatedReply?.authorAgentId
      && Date.parse(e.unrelatedReply.createdAt) >= Date.parse(e.unrelatedComment.createdAt)
      && /\bParis\b/i.test(e.unrelatedReply.body)), detail: "The agent answers the new message while its earlier question remains pending" },
    { id: "historical-answer-recorded", passed: Boolean(e.afterAnswer.id === e.original.id && e.afterAnswer.status === "answered"
      && e.afterAnswer.resolvedByUserId && blueId && answer?.optionIds?.length === 1 && answer.optionIds[0] === blueId), detail: "The reopened original question records the user's Blue selection" },
    { id: "historical-answer-delivered", passed: Boolean(e.lateReply?.authorAgentId && e.lateReply.createdByRunId
      && Date.parse(e.lateReply.createdAt) >= Date.parse(e.afterAnswer.resolvedAt ?? "") && /\bblue\b/i.test(e.lateReply.body)), detail: "A later agent turn acknowledges the saved answer after the original turn ended" },
    { id: "no-unrequested-work", passed: e.taskCount === 0, detail: "No tasks are created by the question, unrelated reply, or late answer" },
  ];
}

export async function runUnansweredQuestionReturn(context: {
  input: ChatFlowInput; issue(): ChatIssue; idle(count: number): Promise<void>; comments(): Promise<Row[]>;
}) {
  const { input } = context;
  const { api, page } = input;
  await sendChatMessage(page, "Help me choose a color for a garden club welcome note. Ask me one interactive question using Paperclip's question card: Which color should the welcome note use? Offer Blue and Green. When I eventually answer, acknowledge my chosen color in chat. For now only ask; do not create tasks or write the note.");
  await context.idle(1);
  const path = `/api/issues/${context.issue().id}/interactions`;
  const original = (await api.get<Row[]>(path)).filter(card => card.kind === "ask_user_questions" && card.status === "pending").at(-1);
  expect(original, "Agent creates an actual saved question").toBeTruthy();
  const questionRow = () => page.getByTestId("task-chat-unanswered-question").filter({ hasText: /color/i });
  await expect(page.getByTestId("task-chat-composer-takeover")).toBeVisible();
  await expect(questionRow()).toBeVisible();
  await input.capture("question-asked", "Original question awaiting an answer", "question-asked.png");
  await page.getByTestId("task-chat-composer-takeover").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(questionRow()).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-takeover")).toHaveCount(0);
  await expect(page.getByTestId("task-chat-pending-input-indicator")).toHaveCount(0);
  await input.capture("question-dismissed", "Dismissing a fresh question leaves only its history card", "question-dismissed.png");
  await questionRow().click();
  await expect(page.getByTestId("task-chat-composer-takeover")).toBeVisible();

  const unrelated = "Leave that color question unanswered for now. What is the capital of France? Answer that in chat; do not create tasks.";
  await sendChatMessage(page, unrelated);
  await context.idle(2);
  const afterMove = (await api.get<Row[]>(path)).find(card => card.id === original!.id)!;
  const moveComments = await context.comments();
  const unrelatedComment = moveComments.findLast(comment => comment.authorUserId && comment.body === unrelated);
  const unrelatedReply = moveComments.findLast(comment => comment.authorAgentId === input.fixtures.agent.id
    && unrelatedComment && comment.createdAt >= unrelatedComment.createdAt);
  expect(afterMove).toMatchObject({ status: "pending", resolvedAt: null, result: null });
  expect(unrelatedReply?.body).toMatch(/\bParis\b/i);
  await expect(page.getByTestId("task-chat-pending-input-indicator")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(questionRow()).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-takeover")).toHaveCount(0);
  await expect(page.getByTestId("task-chat-pending-input-indicator")).toHaveCount(0);
  await input.capture("question-left-unanswered", "After reload: question stays in history without a duplicate composer reminder", "question-left-unanswered.png");

  await questionRow().click();
  const form = page.getByTestId("task-chat-composer-takeover");
  await expect(form).toContainText(/color/i);
  await input.capture("question-reopened", "The original question can be reopened from history", "question-reopened.png");
  await form.getByRole("radio", { name: "Blue", exact: true }).click();
  await form.getByRole("button", { name: /^(Send|Submit) answers$/ }).click();
  await context.idle(3);
  const afterAnswer = (await api.get<Row[]>(path)).find(card => card.id === original!.id)!;
  const lateReply = (await context.comments()).findLast(comment => comment.authorAgentId === input.fixtures.agent.id
    && comment.createdAt >= afterAnswer.resolvedAt);
  const evidence = { original: original!, afterMove, afterAnswer, unrelatedComment, unrelatedReply, lateReply,
    taskCount: (await api.get<Row[]>(`/api/companies/${input.fixtures.company.id}/issues`)).length };
  await input.evidence("unanswered-question.json", evidence);
  for (const check of gradeUnansweredQuestion(evidence)) {
    input.check?.(check.id, check.passed, check.detail);
    expect(check.passed, check.detail).toBe(true);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  const receipt = page.getByTestId("task-chat-answered-questions-receipt");
  await expect(receipt).toBeVisible();
  await expect(page.getByTestId("task-chat-unanswered-question")).toHaveCount(0);
  await receipt.locator("summary").click();
  await expect(receipt).toContainText("Blue");
  await input.capture("question-answered-later", "The historical question stores the submitted Blue answer", "question-answered-later.png");
  const acknowledgement = page.locator(`[id="comment-${lateReply!.id}"]`);
  await expect(acknowledgement).toContainText(/blue/i);
  await acknowledgement.scrollIntoViewIfNeeded();
  await input.capture("question-answer-acknowledged", "The agent acknowledges the late answer in a new chat turn", "question-answer-acknowledged.png");
}
