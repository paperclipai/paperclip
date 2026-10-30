import { expect, type Page } from "@playwright/test";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { taskReplyContentMatches, type ReplyContentPart } from "./task-reply-content.js";

type Row = Record<string, any>;
export interface TaskReplyObservation {
  body: string; anchor: string | null; settled: boolean; nativeFinal: boolean; visible: boolean;
  content?: ReplyContentPart[]; origin?: string; pageUrl?: string; knownCompanyPrefixes?: string[];
}
export type BoundTaskFinalReply = Awaited<ReturnType<typeof readBoundTaskFinalReply>>;

/** Native task replies can render from a saved turn before a completion comment
 * is projected. Respect an explicit presentation decision when one exists. */
export function nativeFinalReplyEvents(events: Row[], run: Row) {
  return events.flatMap(event => {
    const envelope = event.payload?.prpEvent, payload = envelope?.payload, item = payload?.item;
    if (!envelope || !Number.isSafeInteger(event.seq) || event.seq < 1 || !isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion)
      || event.runId !== run.id || event.companyId !== run.companyId || event.agentId !== run.agentId
      || envelope.runId !== run.id || envelope.sourceKind !== "runner" || event.eventType !== "item.completed" || envelope.eventType !== event.eventType
      || typeof envelope.sourceEventId !== "string" || !envelope.sourceEventId || event.sourceEventId !== envelope.sourceEventId
      || typeof envelope.sourceInstanceId !== "string" || !envelope.sourceInstanceId || event.sourceInstanceId !== envelope.sourceInstanceId
      || !Number.isSafeInteger(envelope.sourceSeq) || envelope.sourceSeq < 1 || event.sourceSeq !== envelope.sourceSeq
      || !["agentMessage", "assistant_message"].includes(payload?.kind ?? item?.type) || (payload.channel ?? item?.channel) !== "final"
      || payload.kind != null && item?.type != null && payload.kind !== item.type
      || payload.channel != null && item?.channel != null && payload.channel !== item.channel) return [];
    const text = typeof payload.text === "string" ? payload.text : item?.text;
    if (typeof text !== "string" || !text.trim() || typeof payload.text === "string" && typeof item?.text === "string" && payload.text !== item.text) return [];
    return [{ seq: event.seq, sourceEventId: envelope.sourceEventId, sourceInstanceId: envelope.sourceInstanceId,
      sourceSeq: envelope.sourceSeq, protocolSchemaVersion: event.protocolSchemaVersion, body: text.trim() }];
  });
}

export function taskReplyBelongsToRun(observation: TaskReplyObservation, run: Row, agentId: string, comments: Row[], events: Row[] = []) {
  if (typeof run.id !== "string" || !run.id || !agentId || run.agentId !== agentId || run.status !== "succeeded" || run.runtimeMode !== "native" || !observation.body || !observation.visible) return false;
  const decision = run.resultJson?.presentationDecision;
  if (decision != null && (typeof decision !== "object" || Array.isArray(decision))) return false;
  if (decision?.commentId != null && typeof decision.commentId !== "string") return false;
  const projected = typeof decision?.commentId === "string" ? comments.find(comment => comment.id === decision.commentId) : null;
  if (projected) {
    return observation.anchor === projected.id && projected.authorAgentId === agentId
      && projected.createdByRunId === run.id && typeof projected.body === "string" && taskReplyContentMatches(observation, projected.body);
  }
  const finals = nativeFinalReplyEvents(events, run);
  return finals.length === 1 && taskReplyContentMatches(observation, finals[0]!.body) && observation.settled && observation.nativeFinal
    && (observation.anchor === `${run.id}:turn` || observation.anchor?.startsWith(`${run.id}:turn:`) === true);
}

export function uniqueBoundTaskReply(all: TaskReplyObservation[], run: Row, agentId: string, comments: Row[], expectedText?: string, events: Row[] = []) {
  const matches = all.filter(row => taskReplyBelongsToRun(row, run, agentId, comments, events)
    && (expectedText === undefined || row.body === expectedText));
  return matches.length === 1 && (expectedText === undefined || all.filter(row => row.visible && row.body === expectedText).length === 1)
    ? matches[0]! : null;
}

export function observeTaskReplyElements(elements: Array<HTMLElement | SVGElement>): TaskReplyObservation[] {
  return elements.map(element => {
    const content: Array<{ text: string } | { href: string; label: string; decorated: boolean } | { checked: boolean }> = [];
    const nodes: Array<Node | string> = [element];
    while (nodes.length) {
      const node = nodes.pop()!;
      if (typeof node === "string") { content.push({ text: node }); continue; }
      if (node.nodeType === Node.TEXT_NODE) { content.push({ text: node.textContent ?? "" }); continue; }
      if (!(node instanceof HTMLElement) || node.getAttribute("aria-hidden") === "true"
        || getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") continue;
      if (node instanceof HTMLInputElement && node.type === "checkbox") {
        if (node.getClientRects().length) content.push({ checked: node.checked });
        continue;
      }
      if (node instanceof HTMLAnchorElement) {
        if (node.getClientRects().length && node.innerText.trim()) content.push({ href: node.href, label: node.innerText,
          decorated: node.matches('[data-mention-kind="issue"], [data-sidebar-document-link]') });
        continue;
      }
      const block = ["P", "DIV", "BR", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"].includes(node.tagName);
      if (block) { content.push({ text: " " }); nodes.push(" "); }
      for (let index = node.childNodes.length - 1; index >= 0; index--) nodes.push(node.childNodes[index]!);
    }
    return {
      body: (element as HTMLElement).innerText.trim(),
      content, origin: location.origin, pageUrl: location.href,
      anchor: element.closest("[data-thread-anchor]")?.getAttribute("data-thread-anchor") ?? null,
      settled: element.closest('[data-testid="task-chat-turn"]')?.getAttribute("data-settled") === "true",
      nativeFinal: element.closest('[data-testid="task-chat-final-response"]') !== null,
      visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none",
    };
  });
}

/** Observe the real task thread after a fresh load, rather than a finish summary
 * or a provider's claimed result. The caller separately validates task/run scope. */
export async function readBoundTaskFinalReply(input: {
  page: Page; runId: string; agentId: string; expectedText?: string; deadlineAt: number; knownCompanyPrefixes: string[];
  load(): Promise<{ run: Row; comments: Row[]; events: Row[] }>;
}) {
  await input.page.reload();
  const replies = input.page.getByTestId("task-chat-thread").getByTestId("task-chat-agent-bubble");
  const observe = () => replies.evaluateAll(observeTaskReplyElements);
  const read = async () => {
    const state = await input.load(), all = (await observe()).map(row => ({ ...row, knownCompanyPrefixes: input.knownCompanyPrefixes }));
    const match = state.run.id === input.runId ? uniqueBoundTaskReply(all, state.run, input.agentId, state.comments, input.expectedText, state.events) : null;
    return { ...state, match };
  };
  const timeout = input.deadlineAt - Date.now();
  if (timeout <= 0) throw new Error("native_reply_deadline");
  await expect.poll(async () => {
    return Boolean((await read()).match);
  }, { timeout, intervals: [1000, 2000, 5000] }).toBe(true);
  const { match, run, events, comments } = await read();
  if (!match) throw new Error("native_reply_changed");
  const source = match.anchor === run.resultJson?.presentationDecision?.commentId ? "posted-comment" : "native-turn";
  const finalEvent = source === "native-turn" ? nativeFinalReplyEvents(events, run)[0] : null;
  const sourceBody = source === "posted-comment" ? comments.find(comment => comment.id === match.anchor)?.body : finalEvent?.body;
  if (typeof sourceBody !== "string" || !taskReplyContentMatches(match, sourceBody)) throw new Error("native_reply_source_changed");
  return { runId: input.runId, agentId: input.agentId, observedAfterReload: true,
    source, sourceBody, finalEvent, ...match };
}
