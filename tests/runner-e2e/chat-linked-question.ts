import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import type { AskUserQuestionsInteraction } from "../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
import type { InternalObservation, Entity } from "./chat-catalog-domains/internal-support.js";

interface QuestionInput {
  origin: string; pageUrl: string; companyPrefix: string; sourceId: string; leadId: string; query: string;
  observation: InternalObservation & { runs: Array<InternalObservation["runs"][number] & { finishedAt?: string | null }> };
  comments: Entity[]; interactions: AskUserQuestionsInteraction[]; tasks: Entity[];
}
export function linkedQuestionBinding(input: QuestionInput) {
  const o = input.observation, run = o.runs[0];
  if (o.runs.length !== 1 || !run || run.companyId !== o.companyId || run.agentId !== input.leadId || run.runtimeMode !== "native" || run.status !== "succeeded"
    || run.contextSnapshot?.issueId !== input.sourceId || input.tasks.length !== 2 || new Set(input.tasks.map(task => task.id)).size !== 2
    || input.tasks.some(task => task.companyId !== o.companyId || !o.tasks.some(saved => saved.id === task.id && saved.companyId === task.companyId))) return;
  const humans = input.comments.filter(comment => comment.companyId === o.companyId && comment.issueId === input.sourceId && !comment.authorAgentId
    && !!comment.authorUserId && comment.body === input.query);
  if (humans.length !== 1 || o.humanQueries.length !== 1 || o.humanQueries[0] !== input.query) return;
  const human = humans[0]!, start = Date.parse(run.startedAt ?? ""), end = Date.parse(run.finishedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  const candidates = input.interactions.filter(card => card.kind === "ask_user_questions" && card.status === "pending" && !card.dismissedAt && !card.resolvedAt
    && card.companyId === o.companyId && card.issueId === input.sourceId && card.createdByAgentId === input.leadId && !card.createdByUserId
    && card.sourceRunId === run.id && !card.addresseeAgentId && (!card.addresseeUserId || card.addresseeUserId === human.authorUserId)
    && ["anyone", "human_only", "not_creator"].includes(card.effectiveResolverPolicy)
    && (card.originCommentIds?.includes(human.id) || card.sourceCommentId === human.id)
    && (card.originCommentIds ?? []).every(id => input.comments.some(comment => comment.id === id && comment.companyId === o.companyId && comment.issueId === input.sourceId))
    && (!card.sourceCommentId || card.sourceCommentId === human.id)
    && Date.parse(String(card.createdAt)) >= start && Date.parse(String(card.createdAt)) <= end
    && o.activity.some(event => event.companyId === o.companyId && event.action === "issue.thread_interaction_created"
      && (event as Entity & { entityType?: string }).entityType === "issue" && event.entityId === input.sourceId
      && event.actorType === "agent" && event.actorId === input.leadId && event.agentId === input.leadId
      && (event as Entity & { runId?: string }).runId === run.id && event.details?.interactionId === card.id && event.details?.interactionKind === "ask_user_questions"));
  if (candidates.length !== 1) return;
  const card = candidates[0]!, set = card.payload.questionSet, question = set?.questions[0];
  if (set?.schema !== "paperclip.question_set.v1" || !set.description || !question?.id || !question.prompt) return;
  return { origin: input.origin, pageUrl: input.pageUrl, companyPrefix: input.companyPrefix, tasks: input.tasks.map(task => ({ id: task.id, identifier: task.identifier })), sourceId: input.sourceId, anchorCommentId: human.id, interactionId: card.id, questionId: question.id,
    prompt: question.prompt, sourceRunId: run.id, leadId: input.leadId,
    payloadDigest: createHash("sha256").update(JSON.stringify(card.payload)).digest("hex") };
}
export function readLinkedQuestionDom(input: NonNullable<ReturnType<typeof linkedQuestionBinding>>) {
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0") return false;
    }
    return element.getClientRects().length > 0;
  };
  const selector = '[data-testid="task-chat-thread"]', clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const roots = Array.from(document.querySelectorAll(selector)).filter(root => visible(root) && Array.from(root.querySelectorAll("[id]")).some(node =>
    node.id === `comment-${input.anchorCommentId}` && node.closest(selector) === root));
  if (roots.length !== 1) return;
  const root = roots[0]!, same = (node: Element) => node.closest(selector) === root;
  const button = Array.from(root.querySelectorAll('[data-testid="task-chat-unanswered-question"]')).filter(node =>
    node.id === `interaction-${input.interactionId}` && same(node) && visible(node) && node.getAttribute("aria-label") === `Answer question: ${input.prompt}`);
  if (button.length !== 1) return;
  const takeovers = Array.from(root.querySelectorAll('[data-testid="task-chat-composer-takeover"]')).filter(node => visible(node) && same(node));
  if (takeovers.length !== 1) return;
  const takeover = takeovers[0]!, prompts = Array.from(takeover.querySelectorAll("[id]")).filter(node => node.id === `${input.interactionId}-${input.questionId}-prompt`
    && visible(node) && same(node) && clean(node.textContent ?? "") === clean(input.prompt));
  const contexts = Array.from(takeover.querySelectorAll('[role="region"][aria-label="Question context"]')).filter(node => visible(node) && same(node));
  if (prompts.length !== 1 || contexts.length !== 1) return;
  const links = Array.from(contexts[0]!.querySelectorAll("a[href]")).filter(node => visible(node) && same(node)).map(node => node.getAttribute("href")!);
  const qualified = links.flatMap(href => {
    try {
      const url = new URL(href, input.origin), page = new URL(input.pageUrl);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const unprefixed = parts.length === 2 && parts[0] === "issues";
      if (url.origin !== new URL(input.origin).origin || url.search || url.hash
        || !(parts.length === 3 && parts[0] === input.companyPrefix && parts[1] === "issues" || unprefixed
          && page.origin === url.origin && page.pathname.split("/").filter(Boolean)[0] === input.companyPrefix)) return [];
      const id = parts[unprefixed ? 1 : 2], task = input.tasks.find(task => [task.id, task.identifier].includes(id));
      return task ? [{ href, taskId: task.id }] : [];
    } catch { return []; }
  });
  if (new Set(qualified.map(link => link.taskId)).size !== 2) return;
  return { ...input, links: [...new Set(qualified.map(link => link.href))], text: prompts[0]!.textContent ?? "" };
}
export type LinkedQuestionEvidence = NonNullable<ReturnType<typeof readLinkedQuestionDom>>;
export type ClarificationObservation = InternalObservation & { linkedQuestionEvidence?: LinkedQuestionEvidence };
export async function observeLinkedTaskQuestion(ctx: ChatCatalogContext, state: Record<string, unknown>, observation: InternalObservation): Promise<ClarificationObservation> {
  const source = ctx.issue(), prefix = ctx.input.fixtures.company.issuePrefix;
  if (!source || !prefix || ctx.scenario.id !== "tasks.ambiguous-task") return observation;
  const [comments, interactions] = await Promise.all([
    ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`),
    ctx.input.api.get<AskUserQuestionsInteraction[]>(`/api/issues/${source.id}/interactions`),
  ]);
  const binding = linkedQuestionBinding({ origin: observation.origin, pageUrl: ctx.input.page.url(), companyPrefix: prefix, sourceId: source.id, leadId: observation.leadId,
    query: ctx.scenario.query, observation, comments, interactions, tasks: [state.task as Entity, state.otherTask as Entity] });
  if (!binding) return observation;
  const evidence = await ctx.input.page.evaluate(readLinkedQuestionDom, binding);
  return evidence ? { ...observation, reply: [observation.reply, evidence.text].filter(Boolean).join("\n"), links: [...new Set([...observation.links, ...evidence.links])], linkedQuestionEvidence: evidence } : observation;
}
export function linkedQuestionTakeover(page: Page, evidence: LinkedQuestionEvidence): Locator {
  return page.getByTestId("task-chat-thread").filter({ has: page.locator(`[id=${JSON.stringify(`comment-${evidence.anchorCommentId}`)}]`) })
    .getByTestId("task-chat-composer-takeover").filter({ has: page.locator(`[id=${JSON.stringify(`${evidence.interactionId}-${evidence.questionId}-prompt`)}]`) });
}
