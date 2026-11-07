import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { IssueComment, IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import { sendChatMessage } from "../chat-flow.js";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { humanQueuedRuntime, probeConsumedHumanQueue } from "./runtime-queue-controls.js";
import { runtimeQueueCases } from "./runtime-queue.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";

const contactText = "Also add a contact section to the website.";
export function gradeDiscard(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-pending-and-consumed-cancellation-evidence", !!o, "Both actual human discard and separately consumed input with later new direction are required."); if (!o) return c.result();
  const s = o.state, before = s.queueBefore as IssueQueuedCommentQueue, after = s.queueAfterDiscard as IssueQueuedCommentQueue;
  const target = before?.entries.find(row => row.comment.id === s.targetId);
  c.add("only-owned-pending-message-discarded", !!target && target.comment.authorUserId === s.humanId && !target.comment.authorAgentId
    && target.comment.body === contactText && !!after && after.issueId === before.issueId && after.entries.length === 1
    && after.entries[0]?.comment.id === before.entries.find(row => row.comment.id !== s.targetId)?.comment.id
    && after.entries[0]?.comment.body === before.entries.find(row => row.comment.id !== s.targetId)?.comment.body,
  "The supported human control removes precisely the eligible owned contact request and preserves its neighbour.");
  c.add("history-and-ui-retain-truthful-discard", s.discardVisible === true && s.discardedCommentStatus === 404
    && o.activity.some(row => row.action === "issue.queued_comment_discarded" && row.actorType === "user" && row.actorId === s.humanId
      && row.entityId === (s.task as Entity).id && row.details?.commentId === s.targetId) && s.discardedNeverDelivered === true,
  "Actual absent pending comment, retained human audit history and consuming-run wake IDs prove this pending instruction will not be delivered.");
  c.add("chat-guides-supported-human-discard", /queue|pending|waiting/i.test(String(s.queryReply)) && /discard|remove|cancel/i.test(String(s.queryReply))
    && /you|human|control|menu|button/i.test(String(s.queryReply)) && !/I(?:'ve| have)? (?:already )?(?:deleted|discarded|cancelled)/i.test(String(s.queryReply)) && s.agentDiscardStatus === 403,
  "The canonical reply guides the person to their actual discard control instead of impersonating a user-owned mutation.");
  c.add("already-delivered-input-cannot-be-erased", s.consumedBeforeCancellation === true && s.consumedStillReadable === true
    && s.lateDiscardStatus === 409 && s.latePhaseAttributed === true && /already|deliver|consum|processed|history/i.test(String(s.lateReply))
    && /new|direction|follow.up|remove|change/i.test(String(s.lateReply)) && !/erased.*(?:input|history)|(?:unsent|undelivered|never delivered).*request/i.test(String(s.lateReply)),
  "The separately attributed later answer reports that the later request was consumed and treats cancellation as new direction.");
  c.add("new-direction-reaches-exactly-one-native-continuation", s.cancelDirectionRunBound === true && s.finalQueueEmpty === true && s.finalPlanWithoutContact === true
    && s.initialRevisionRetained === true && o.runs.length === 5 && o.runs.every(row => row.status === "succeeded") && o.tasks.length === 1
    && o.tasks[0]?.id === (s.task as Entity).id && o.tasks[0]?.status === "done",
  "A distinct saved instruction reaches one real later worker, updates the saved plan and preserves prior work/history without replaying the discarded request.");
  return c.result();
}
export const runtimeDiscardCases = [runtimeDefinition("steering.discard-queued-message", ctx => humanQueuedRuntime(ctx, contactText), gradeDiscard, {
  authentication: "human-session", expectedHumanMessageCount: 2, expectedRunCount: 5, attemptTimeoutMs: 1_020_000,
  sourceFiles: ["chat-catalog-domains/runtime-discard.ts", "chat-catalog-domains/runtime-queue-controls.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/steering.yaml"],
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  async act(ctx, state) {
    await pollUntil({ label: "Human discard guidance while Morgan is genuinely active", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running")
        && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity, root = `/api/issues/${task.id}`, queuePath = `${root}/queued-comments`;
    const initial = await ctx.input.api.get<IssueQueuedCommentQueue>(queuePath), targetId = String(state.targetId);
    state.agentDiscardStatus = await probeAgentPermission(ctx, `${queuePath}/${targetId}`, "DELETE", { queueId: initial.queueId, revision: initial.revision });
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.getByTestId(`task-chat-queued-discard-${targetId}`).click();
    state.queueAfterDiscard = await pollUntil({ label: "Only the owned contact request is removed", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(queuePath), accept: q => q.entries.length === 1 && q.entries.every(row => row.comment.id !== targetId) });
    await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${targetId}`)).toHaveCount(0);
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${initial.entries.find(row => row.comment.id !== targetId)!.comment.id}`)).toBeVisible();
    state.discardVisible = true; state.discardedCommentStatus = (await ctx.input.page.request.get(`${root}/comments/${targetId}`)).status();
    await ctx.input.capture("actual-human-contact-discard", "Only the eligible contact request has left the real task queue", "runtime-discard.png");
    // This new, explicit human request is a distinct later instruction. It
    // deliberately reaches normal native delivery before its cancellation.
    const secondText = `I have changed my mind: add a contact section to the saved website plan, labelled ${ctx.input.nonce}. Keep the accessible-font requirement and finish this task.`;
    await submitTaskReply(ctx.input.page, secondText);
    const secondQueue = await pollUntil({ label: "Distinct human contact request genuinely queued", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(queuePath), accept: q => q.entries.length === 2 && q.entries.some(row => row.comment.body === secondText) });
    const second = secondQueue.entries.find(row => row.comment.body === secondText)!;
    state.secondContactId = second.comment.id;
    await writeFile((state.gate as { gate: string }).gate, "The human brief is ready: save an initial website-plan task document, retaining accessible font guidance, then finish this turn normally. Leave saved follow-ups for their ordinary continuation.", "utf8");
    const consumed = await pollUntil({ label: "Real later contact request consumed before cancellation", deadlineAt: Date.now() + 240_000,
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<Entity>(root), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(queuePath) }),
      accept: v => v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") && v.task.status === "done" && v.queue.entries.length === 0 });
    const consumer = consumed.runs.find(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId)!;
    const detail = await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[] }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${consumer.id}`);
    state.consumedBeforeCancellation = detail.contextSnapshot?.wakeCommentIds?.includes(second.comment.id) === true
      && detail.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(secondText) === true;
    state.discardedNeverDelivered = consumed.runs.every(row => !((row.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(targetId));
    state.lateDiscardStatus = await probeConsumedHumanQueue(ctx, String(state.humanId), `${queuePath}/${second.comment.id}`, "DELETE", { queueId: secondQueue.queueId, revision: secondQueue.revision });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const message = `I later queued a different contact request on Website ${task.identifier ?? task.id}, comment ${second.comment.id}, and Morgan has already consumed it. Cancel that later contact requirement now by sending Morgan new direction to remove the contact section from the saved website plan while retaining the accessible-font requirement. Explain what happened to the already-delivered input; do not erase or rewrite it.`;
    const priorIds = consumed.runs.map(row => row.id);
    await sendChatMessage(ctx.input.page, message, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "One real new-direction continuation after already-delivered cancellation", deadlineAt: Date.now() + 300_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), task: await ctx.input.api.get<Entity>(root), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(queuePath) }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 5 && v.runs.every(row => row.status === "succeeded") && v.task.status === "done" && v.queue.entries.length === 0,
      reject: v => v.runs.length > 5 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The declared later cancellation failed or duplicated execution" : undefined });
    const later = final.runs.filter(row => !priorIds.includes(row.id)), lead = later.find(row => row.agentId === ctx.input.fixtures.agent.id), worker = later.find(row => row.agentId === (state.worker as Entity).id);
    const sourceComments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = sourceComments.filter(row => !row.authorAgentId && row.body === message);
    const replies = sourceComments.filter(row => row.createdByRunId === lead?.id && row.authorAgentId === ctx.input.fixtures.agent.id);
    const leadInput = lead && await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${lead.id}`);
    state.latePhaseAttributed = human.length === 1 && !!lead && replies.length > 0 && leadInput?.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true;
    state.lateReply = replies.map(row => row.body).join("\n");
    const comments = await ctx.input.api.get<IssueComment[]>(`${root}/comments?order=asc`), direction = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === lead?.id);
    const workerInput = worker && await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[]; wakeCommentId?: string }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${worker.id}`);
    state.cancelDirectionRunBound = later.length === 2 && !!worker && direction.length === 1 && /remov|without|cancel|omit|no contact/i.test(direction[0]!.body)
      && [...(workerInput?.contextSnapshot?.wakeCommentIds ?? []), workerInput?.contextSnapshot?.wakeCommentId].includes(direction[0]!.id)
      && workerInput?.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(direction[0]!.body) === true;
    state.finalWorkerRunId = worker?.id; state.consumedStillReadable = comments.some(row => row.id === second.comment.id && row.body === secondText && !row.deletedAt);
    state.finalQueueEmpty = final.queue.entries.length === 0;
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.initialRevisionRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && row.createdByAgentId === (state.worker as Entity).id);
    const latest = o.revisions.filter(row => row.createdByRunId === state.finalWorkerRunId && row.createdByAgentId === (state.worker as Entity).id
      && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
    state.finalPlanWithoutContact = latest.some(row => /accessib|readable font/i.test(row.body ?? "")
      && (!/contact/i.test(row.body ?? "") || /contact.*(?:removed|omitted|cancelled)|(?:removed|omitted|cancelled|without|no)\b.*contact/i.test(row.body ?? "")));
    return o;
  },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); } },
})];
