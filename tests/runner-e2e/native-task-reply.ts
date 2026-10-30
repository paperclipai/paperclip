import { expect, type Page } from "@playwright/test";

type Row = Record<string, any>;
export interface TaskReplyObservation {
  body: string; anchor: string | null; settled: boolean; nativeFinal: boolean; visible: boolean;
}

/** Native task replies can render from a saved turn before a completion comment
 * is projected. Respect an explicit presentation decision when one exists. */
export function taskReplyBelongsToRun(observation: TaskReplyObservation, run: Row, agentId: string, comments: Row[]) {
  if (typeof run.id !== "string" || !run.id || !agentId || run.agentId !== agentId || run.status !== "succeeded" || run.runtimeMode !== "native" || !observation.body || !observation.visible) return false;
  const decision = run.resultJson?.presentationDecision;
  if (decision !== undefined) {
    return typeof decision?.commentId === "string" && observation.anchor === decision.commentId
      && comments.some(comment => comment.id === decision.commentId && comment.authorAgentId === agentId
        && comment.createdByRunId === run.id && typeof comment.body === "string" && comment.body.trim() === observation.body);
  }
  return observation.settled && observation.nativeFinal
    && (observation.anchor === `${run.id}:turn` || observation.anchor?.startsWith(`${run.id}:turn:`) === true);
}

export function uniqueBoundTaskReply(all: TaskReplyObservation[], run: Row, agentId: string, comments: Row[], expectedText?: string) {
  const matches = all.filter(row => taskReplyBelongsToRun(row, run, agentId, comments)
    && (expectedText === undefined || row.body === expectedText));
  return matches.length === 1 && (expectedText === undefined || all.filter(row => row.visible && row.body === expectedText).length === 1)
    ? matches[0]! : null;
}

/** Observe the real task thread after a fresh load, rather than a finish summary
 * or a provider's claimed result. The caller separately validates task/run scope. */
export async function readBoundTaskFinalReply(input: {
  page: Page; runId: string; agentId: string; expectedText?: string; deadlineAt: number;
  load(): Promise<{ run: Row; comments: Row[] }>;
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
    const match = state.run.id === input.runId ? uniqueBoundTaskReply(all, state.run, input.agentId, state.comments, input.expectedText) : null;
    return { ...state, match };
  };
  const timeout = Math.min(30_000, input.deadlineAt - Date.now());
  if (timeout <= 0) throw new Error("native_reply_deadline");
  await expect.poll(async () => {
    return Boolean((await read()).match);
  }, { timeout, intervals: [250, 500, 1000] }).toBe(true);
  const { match, run } = await read();
  if (!match) throw new Error("native_reply_changed");
  return { runId: input.runId, agentId: input.agentId, observedAfterReload: true,
    source: run.resultJson?.presentationDecision === undefined ? "native-turn" : "posted-comment", ...match };
}
