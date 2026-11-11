import type { Locator, Page } from "@playwright/test";
import type { ChatRun } from "./chat-flow.js";

interface Row { id: string; companyId?: string; issueId?: string; authorAgentId?: string | null; createdByRunId?: string | null; name?: string; action?: string; entityType?: string; entityId?: string; agentId?: string | null; actorType?: string; actorId?: string; runId?: string | null }
export interface RenderedConversationLink {
  threadTestId: "task-chat-thread" | "thread-root"; href: string; source: "reply" | "project-created-card"; conversationId: string; anchorCommentId: string;
  commentId?: string; resourceId?: string; cardLabel?: string; createdByRunId?: string;
}
export interface ConversationLinkInput {
  origin: string; companyId: string; companyPrefix?: string | null; sourceId: string; leadId: string;
  comments: Row[]; runs: ChatRun[]; projects: Row[]; activity: Row[];
}
export function conversationLinkBindings(input: ConversationLinkInput) {
  const comments = input.comments.filter(row => row.companyId === input.companyId && row.issueId === input.sourceId);
  const replies = comments.filter(row => row.authorAgentId === input.leadId && input.runs.some(run =>
    run.id === row.createdByRunId && run.companyId === input.companyId && run.agentId === input.leadId
    && ((run as ChatRun & { nativeIssueId?: string }).nativeIssueId ?? run.contextSnapshot?.issueId) === input.sourceId));
  const projects = input.projects.flatMap(project => {
    if (project.companyId !== input.companyId || !project.name) return [];
    const creation = input.activity.find(row => row.companyId === input.companyId && row.action === "project.created"
      && row.entityType === "project" && row.entityId === project.id && row.actorType === "agent"
      && row.actorId === input.leadId && row.agentId === input.leadId
      && replies.some(reply => reply.createdByRunId === row.runId));
    return creation?.runId ? [{ id: project.id, name: project.name, runId: creation.runId }] : [];
  });
  return { origin: input.origin, companyPrefix: input.companyPrefix, sourceId: input.sourceId,
    anchors: comments.map(row => row.id), replies: replies.map(row => row.id), projects };
}
export function readConversationDomLinks(input: ReturnType<typeof conversationLinkBindings>): RenderedConversationLink[] {
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0") return false;
    }
    return element.getClientRects().length > 0;
  };
  const threadSelector = '[data-testid="task-chat-thread"], [data-testid="thread-root"]';
  const roots = Array.from(document.querySelectorAll(threadSelector)).filter(root => visible(root)
    && input.anchors.some(id => Array.from(root.querySelectorAll("[id]")).some(node => node.id === `comment-${id}` && node.closest(threadSelector) === root)));
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  const threadTestId = root.getAttribute("data-testid") as RenderedConversationLink["threadTestId"];
  const anchor = input.anchors.find(id => Array.from(root.querySelectorAll("[id]")).some(node => node.id === `comment-${id}`))!;
  const rows: RenderedConversationLink[] = [];
  const sameConversation = (node: Element) => node.closest(threadSelector) === root;
  const companyResource = (href: string) => {
    try {
      const url = new URL(href, input.origin), parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const resourceAt = parts.findIndex(part => ["projects", "issues", "goals"].includes(part));
      if (url.origin !== new URL(input.origin).origin) return !(resourceAt === 1 && parts.length === 3);
      return resourceAt < 0 || resourceAt === 1 && parts[0] === input.companyPrefix;
    } catch { return false; }
  };
  for (const id of input.replies) {
    const reply = Array.from(root.querySelectorAll("[id]")).find(node => node.id === `comment-${id}` && sameConversation(node));
    for (const node of reply?.querySelectorAll("a[href]") ?? []) {
      const href = node.getAttribute("href");
      if (href && sameConversation(node) && visible(node) && companyResource(href)) rows.push({ threadTestId, href, source: "reply", conversationId: input.sourceId, anchorCommentId: id, commentId: id });
    }
  }
  for (const project of threadTestId === "task-chat-thread" ? input.projects : []) {
    const label = `Project created: ${project.name}`;
    for (const card of root.querySelectorAll("article[aria-label]")) {
      const item = card.closest('[data-thread-item-kind="project_created"]');
      if (item?.getAttribute("data-thread-anchor") !== `project-created:${project.id}` || card.getAttribute("aria-label") !== label || card.closest('[id^="comment-"]') || !sameConversation(card) || !visible(card)) continue;
      for (const node of card.querySelectorAll("a[href]")) {
        const href = node.getAttribute("href");
        if (!href || !visible(node) || !sameConversation(node)) continue;
        try {
          const url = new URL(href, input.origin), parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
          if (url.origin !== new URL(input.origin).origin || parts.length !== 3 || parts[0] !== input.companyPrefix || parts[1] !== "projects" || parts[2] !== project.id) continue;
          rows.push({ threadTestId, href, source: "project-created-card", conversationId: input.sourceId, anchorCommentId: anchor, resourceId: project.id, cardLabel: label, createdByRunId: project.runId });
        } catch { continue; }
      }
    }
  }
  return rows;
}
/** The API reports a saved reply before the open conversation renders it.
 * When this conversation is open in the page, wait (bounded) for its latest
 * saved lead reply to render so rendered links are not read too early. A page
 * that is not showing this conversation is left alone. */
export const CONVERSATION_REPLY_RENDER_WAIT_MS = 10_000;
// A reply that did not render within one wait is not waited for again on the same page, so repeated
// observations in a poll loop pay the wait at most once per reply.
const expiredReplyWaits = new WeakMap<object, Set<string>>();
export type ConversationReplyRender = "closed" | "rendered" | "pending";
export function readLatestConversationReplyRender(input: { anchors: string[]; latest: string }): ConversationReplyRender {
  const threadSelector = '[data-testid="task-chat-thread"], [data-testid="thread-root"]';
  // A thread is this conversation's when every comment it renders is one of its saved comments; a thread that
  // has not rendered any comment yet (still loading after navigation or reload) counts too.
  const roots = Array.from(document.querySelectorAll(threadSelector)).filter(root =>
    Array.from(root.querySelectorAll('[id^="comment-"]')).every(node => input.anchors.some(id => node.id === `comment-${id}`)));
  if (!roots.length) return "closed";
  const rendered = roots.some(root => Array.from(root.querySelectorAll('[id^="comment-"]'))
    .some(node => node.id === `comment-${input.latest}` && node.getClientRects().length > 0));
  return rendered ? "rendered" : "pending";
}
export async function waitForLatestConversationReplyRender(page: Pick<Page, "evaluate">, bindings: Pick<ReturnType<typeof conversationLinkBindings>, "anchors" | "replies">,
  timeoutMs = CONVERSATION_REPLY_RENDER_WAIT_MS, intervalMs = 250): Promise<ConversationReplyRender> {
  const latest = bindings.replies.at(-1);
  if (!latest) return "rendered";
  const expired = expiredReplyWaits.get(page) ?? new Set<string>();
  if (expired.has(latest)) timeoutMs = 0;
  // Bounded by attempts as well as time so a frozen test clock cannot spin.
  for (let attempt = 0, attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs)), deadlineAt = Date.now() + timeoutMs; ; attempt++) {
    let state: unknown;
    try { state = await page.evaluate(readLatestConversationReplyRender, { anchors: bindings.anchors, latest }); } catch { return "closed"; }
    if (state !== "pending") return state === "closed" ? "closed" : "rendered";
    if (attempt + 1 >= attempts || Date.now() >= deadlineAt) { expired.add(latest); expiredReplyWaits.set(page, expired); return "pending"; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
export async function collectConversationLinks(page: Page, input: ConversationLinkInput) {
  const bindings = conversationLinkBindings(input);
  await waitForLatestConversationReplyRender(page, bindings);
  return page.evaluate(readConversationDomLinks, bindings);
}
export function conversationLinkLocator(page: Page, link: RenderedConversationLink): Locator {
  const thread = page.getByTestId(link.threadTestId).filter({ has: page.locator(`[id=${JSON.stringify(`comment-${link.anchorCommentId}`)}]`) });
  return link.source === "reply"
    ? thread.locator(`[id=${JSON.stringify(`comment-${link.commentId}`)}] a[href=${JSON.stringify(link.href)}]`)
    : thread.getByRole("article", { name: link.cardLabel!, exact: true }).locator(`a[href=${JSON.stringify(link.href)}]`);
}
