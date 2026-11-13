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
/** Markdown link targets written in saved text, e.g. a reply body: inline [label](target), reference
 * definitions ([label]: target) and autolinks (<https://...>). */
export function markdownLinkTargets(text: string): string[] {
  const unwrap = (target: string) => target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
  return [
    ...[...text.matchAll(/\]\(\s*([^)\s]+)/g)].map(match => unwrap(match[1]!)),
    ...[...text.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm)].map(match => unwrap(match[1]!)),
    ...[...text.matchAll(/<((?:https?:\/\/|\/)[^>\s]+)>/g)].map(match => match[1]!),
  ];
}
export function mislabeledIssueLinks(text: string, identifierFor: (pathId: string) => string | undefined = () => undefined): string[] {
  const identifier = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
  return [...text.matchAll(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?[^)]*\)?/g)].flatMap(match => {
    const label = match[1]!, target = match[2]!;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(target, "http://paperclip.invalid").pathname); } catch { return []; }
    const parts = pathname.split("/").filter(Boolean); const index = parts.indexOf("issues"); const pathId = index >= 0 ? parts[index + 1] : undefined;
    if (!pathId) return [];
    const opened = (identifier.test(pathId) ? pathId : identifierFor(pathId))?.toUpperCase();
    if (!opened) return [];
    const prefix = opened.split("-")[0]!;
    const named = [...label.matchAll(/(?<![\w-])([A-Za-z][A-Za-z0-9]*-\d+)(?![\w-])/g)].map(token => token[1]!.toUpperCase())
      .filter(token => token.split("-")[0] === prefix);
    return named.length > 0 && !named.includes(opened) ? [match[0]] : [];
  });
}
/** A link target that still holds a template placeholder such as <prefix> or {companyId}; it opens no real page. */
export function unresolvedLinkTarget(href: string): boolean {
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* keep the raw target */ }
  return /[<>{}]/.test(decoded);
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
// A reply that did not render within one wait is not waited for again in the same loaded document, so
// repeated observations in a poll loop pay the wait at most once per reply. The expiry belongs to the
// document, not the Playwright page: after a reload or navigation the thread renders again from scratch,
// and reading it instantly then would capture no links although the reply renders moments later.
const expiredReplyWaits = new WeakMap<object, Set<string>>();
export function readConversationDocumentIdentity(): string {
  const view = window as typeof window & { __paperclipConversationLinkDocument?: string };
  return view.__paperclipConversationLinkDocument ??= `${performance.timeOrigin}:${Math.random()}`;
}
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
  let documentIdentity: string;
  try { documentIdentity = await page.evaluate(readConversationDocumentIdentity); } catch { return "closed"; }
  const waitKey = `${documentIdentity}:${latest}`;
  const expired = expiredReplyWaits.get(page) ?? new Set<string>();
  if (expired.has(waitKey)) timeoutMs = 0;
  // Bounded by attempts as well as time so a frozen test clock cannot spin.
  for (let attempt = 0, attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs)), deadlineAt = Date.now() + timeoutMs; ; attempt++) {
    let state: unknown;
    try { state = await page.evaluate(readLatestConversationReplyRender, { anchors: bindings.anchors, latest }); } catch { return "closed"; }
    if (state !== "pending") return state === "closed" ? "closed" : "rendered";
    if (attempt + 1 >= attempts || Date.now() >= deadlineAt) { expired.add(waitKey); expiredReplyWaits.set(page, expired); return "pending"; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
/** A finished run's reply comment can be saved shortly after the run itself is recorded as finished, and the open
 * conversation renders it later still. Before acting on a turn's rendered links, wait (bounded) for each finished
 * lead run's saved reply, then for the latest to render. "unsaved" means no run saved a reply in time. */
export const TURN_REPLY_SAVE_WAIT_MS = 15_000;
export async function waitForSavedTurnReplyRender(page: Pick<Page, "evaluate">, input: {
  comments: () => Promise<Row[]>; leadId: string; runIds: readonly string[];
}, timeoutMs = TURN_REPLY_SAVE_WAIT_MS, intervalMs = 250): Promise<ConversationReplyRender | "unsaved"> {
  const deadlineAt = Date.now() + timeoutMs;
  for (let attempt = 0, attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs)); ; attempt++) {
    const rows = await input.comments();
    const replies = rows.filter(row => row.authorAgentId === input.leadId && input.runIds.includes(String(row.createdByRunId)));
    const saved = input.runIds.length > 0 && input.runIds.every(id => replies.some(row => row.createdByRunId === id));
    if (saved || attempt + 1 >= attempts || Date.now() >= deadlineAt) {
      if (!replies.length) return "unsaved";
      return waitForLatestConversationReplyRender(page, { anchors: rows.map(row => String(row.id)), replies: replies.map(row => String(row.id)) },
        Math.max(CONVERSATION_REPLY_RENDER_WAIT_MS, deadlineAt - Date.now()), intervalMs);
    }
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
