import { expect, type Page } from "@playwright/test";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";

type Row = Record<string, any>;
export interface TaskReplyObservation {
  body: string; anchor: string | null; settled: boolean; nativeFinal: boolean; visible: boolean;
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
      && projected.createdByRunId === run.id && typeof projected.body === "string" && projected.body.trim() === observation.body;
  }
  const finals = nativeFinalReplyEvents(events, run);
  return finals.length === 1 && finals[0]!.body === observation.body && observation.settled && observation.nativeFinal
    && (observation.anchor === `${run.id}:turn` || observation.anchor?.startsWith(`${run.id}:turn:`) === true);
}

export function uniqueBoundTaskReply(all: TaskReplyObservation[], run: Row, agentId: string, comments: Row[], expectedText?: string, events: Row[] = []) {
  const matches = all.filter(row => taskReplyBelongsToRun(row, run, agentId, comments, events)
    && (expectedText === undefined || row.body === expectedText));
  return matches.length === 1 && (expectedText === undefined || all.filter(row => row.visible && row.body === expectedText).length === 1)
    ? matches[0]! : null;
}

/** Observe the real task thread after a fresh load, rather than a finish summary
 * or a provider's claimed result. The caller separately validates task/run scope. */
export async function readBoundTaskFinalReply(input: {
  page: Page; runId: string; agentId: string; expectedText?: string; deadlineAt: number;
  load(): Promise<{ run: Row; comments: Row[]; events: Row[] }>;
}) {
  await input.page.reload();
  const replies = input.page.getByTestId("task-chat-thread").getByTestId("task-chat-agent-bubble");
  const observe = () => replies.evaluateAll(elements => elements.map(element => ({
    body: (element as HTMLElement).innerText.trim(),
    anchor: element.closest("[data-thread-anchor]")?.getAttribute("data-thread-anchor") ?? null,
    settled: element.closest('[data-testid="task-chat-turn"]')?.getAttribute("data-settled") === "true",
    nativeFinal: element.closest('[data-testid="task-chat-final-response"]') !== null,
    visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none",
  })));
  const read = async () => {
    const state = await input.load(), all = await observe();
    const match = state.run.id === input.runId ? uniqueBoundTaskReply(all, state.run, input.agentId, state.comments, input.expectedText, state.events) : null;
    return { ...state, match };
  };
  const timeout = input.deadlineAt - Date.now();
  if (timeout <= 0) throw new Error("native_reply_deadline");
  await expect.poll(async () => {
    return Boolean((await read()).match);
  }, { timeout, intervals: [1000, 2000, 5000] }).toBe(true);
  const { match, run, events } = await read();
  if (!match) throw new Error("native_reply_changed");
  const source = match.anchor === run.resultJson?.presentationDecision?.commentId ? "posted-comment" : "native-turn";
  return { runId: input.runId, agentId: input.agentId, observedAfterReload: true,
    source, finalEvent: source === "native-turn" ? nativeFinalReplyEvents(events, run)[0] : null, ...match };
}
