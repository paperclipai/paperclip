import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { checks, hasLink, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes, waitForTurnReplyLinks } from "./identity-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { handledInTurn, keyboardMoveQueuedMessageUp, readCurrentRevision, runCommentReceipts, runtimeQueueCases, settledQueue, wakeMarksEarlierRead } from "./runtime-queue.js";
import { observeRuntime, runtimeDefinition, runtimeObservation } from "./runtime-support.js";

const otherText = "Use a readable font with accessible labels.";
const redText = "Make the website red. Keep the existing note about accessible labels.";
const blueText = "Make the website blue. Keep the existing note about accessible labels.";
type State = Record<string, unknown>;
function endpoint(state: State) { return `/api/issues/${(state.task as Entity).id}/queued-comments`; }
async function queue(ctx: ChatCatalogContext, state: State) { return ctx.input.api.get<IssueQueuedCommentQueue>(endpoint(state)); }
function taskUrl(ctx: ChatCatalogContext, state: State) { const task = state.task as Entity; return `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`; }
export async function humanQueuedRuntime(ctx: ChatCatalogContext, targetText = redText): Promise<State> {
  const state: State = await busyRuntimeWorker(ctx); const source = ctx.input.page.url();
  await ctx.input.page.goto(taskUrl(ctx, state), { waitUntil: "domcontentloaded" });
  await submitTaskReply(ctx.input.page, otherText); await submitTaskReply(ctx.input.page, targetText);
  const before = await pollUntil({ label: "Two real user-owned messages saved behind Morgan's active turn", deadlineAt: Date.now() + 30_000,
    load: () => queue(ctx, state), accept: q => q.entries.length === 2 && q.entries[0]?.comment.body === otherText && q.entries[1]?.comment.body === targetText });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (before.entries.some(row => row.comment.authorUserId !== session.user.id || row.comment.authorAgentId || !row.canEdit)) throw new Error("Queue fixture is not genuinely owned by the signed-in human");
  Object.assign(state, { queueBefore: before, targetId: before.entries[1]!.comment.id, humanId: session.user.id, concurrentMarker: `Preserve the human note ${ctx.input.nonce}.` });
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); return state;
}
export async function probeConsumedHumanQueue(ctx: ChatCatalogContext, humanId: string, endpoint: string, method: "PATCH" | "DELETE", data: unknown) {
  const origin = ctx.input.api.baseURL, url = new URL(endpoint, origin);
  if (ctx.scenario.id !== "steering.edit-queued-message" && ctx.scenario.id !== "steering.discard-queued-message") throw new Error("Consumed queue probe requires its declared human scenario");
  if (!humanId || new URL(ctx.input.page.url()).origin !== origin || url.origin !== origin || url.search || url.hash
    || !/^\/api\/issues\/[^/]+\/queued-comments\/[^/]+$/.test(url.pathname)) throw new Error("Consumed queue probe escaped its human fixture");
  const apiSession = await ctx.input.api.get<{ user?: { id?: string } }>("/api/auth/get-session");
  const browserSession = await ctx.input.page.request.get(`${origin}/api/auth/get-session`, { maxRedirects: 0 });
  if (browserSession.status() !== 200 || apiSession.user?.id !== humanId || (await browserSession.json() as { user?: { id?: string } }).user?.id !== humanId)
    throw new Error("Consumed queue probe requires the original authenticated human in both contexts");
  const response = await ctx.input.page.request.fetch(url.href, { method, data, headers: { Origin: origin }, maxRedirects: 0, timeout: 15_000 });
  return response.status();
}
async function edit(page: Page, id: string, body: string) {
  await page.getByTestId(`task-chat-queued-message-${id}`).getByRole("button", { name: /^Queued message actions:/ }).click();
  await page.getByRole("menuitem", { name: "Edit message", exact: true }).click();
  await page.getByTestId("task-chat-composer-input").last().locator('[contenteditable="true"], textarea').first().fill(body);
}
export function gradeQueueEdit(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-human-queue-evidence", !!o, "The owned queue, native delivery, visible conflicts and saved full text are required."); if (!o) return c.result();
  const s = o.state, before = s.queueBefore as IssueQueuedCommentQueue, after = s.queueAfter as IssueQueuedCommentQueue;
  const target = before?.entries.find(row => row.comment.id === s.targetId), saved = after?.entries.find(row => row.comment.id === s.targetId);
  c.add("human-owned-undispatched-target", !!target && target.comment.body === redText && target.comment.authorUserId === s.humanId && !target.comment.authorAgentId
    && target.canEdit && before.issueId === (s.task as Entity).id && before.targetRunId === s.workerRunId, "The original red request belongs to the actual signed-in human and waits behind this actual native run.");
  c.add("full-edited-text-and-first-position-persist", !!saved && saved.position === 0 && saved.comment.body === `${blueText} ${s.concurrentMarker}`
    && saved.comment.authorUserId === s.humanId && !saved.comment.authorAgentId && after.entries.length === 2
    && after.entries.some(row => row.comment.body === otherText && row.position === 1), "The same comment retains its author, the complete changed text, the concurrent human note and first position; the other message is intact.");
  // Graded on saved state and the rendered link, never wording ("change ... and drag it above" and "use Edit in its
  // menu" are both correct guidance). The reply links the task whose queue holds the person's controls, the agent's
  // own edit and reorder are refused, and at the reply the queue is exactly as the person left it: no edit applied.
  const atReply = s.queueAtReply as IssueQueuedCommentQueue | undefined;
  const unchangedAtReply = !!before && !!atReply && atReply.entries.length === before.entries.length && before.entries.every(old => atReply.entries.some(row =>
    row.comment.id === old.comment.id && row.position === old.position && row.comment.body === old.comment.body && row.comment.authorUserId === old.comment.authorUserId && !row.comment.authorAgentId));
  const replyLinks = Array.isArray(s.queryLinks) ? s.queryLinks as string[] : [];
  c.add("chat-guides-human-control-without-forging", !!String(s.queryReply ?? "").trim() && !!s.task && hasLink({ ...o, links: replyLinks }, "issues", s.task as Entity)
    && unchangedAtReply && s.agentEditStatus === 403 && s.agentOrderStatus === 403,
  "The canonical reply links the task whose queue holds the person's controls, the actual agent cannot edit or reorder the person's message, and no edit was applied before the person acted.");
  c.add("concurrent-edit-rejects-stale-request-visibly", s.concurrentStatus === 409 && s.concurrentErrorVisible === true && s.concurrentSaveRetained === true,
    "An actual held old-revision human request loses to a real second-session edit and shows its conflict, retaining the winner's text.");
  c.add("dispatched-edit-is-visible-new-direction", s.dispatchedStatus === 409 && s.dispatchedWarningVisible === true && s.originalCommentStillReadable === true,
    "After actual dispatch, the old edit rejects and the real composer offers a new message rather than rewriting consumed history.");
  const queued = Array.isArray(s.queuedComments) ? s.queuedComments as Array<{ id: string; updatedAt?: unknown }> : [];
  const receipts = s.workerCommentReceipts as { reads?: Record<string, string>; cited?: string[] } | undefined, worker = s.worker as Entity | undefined;
  const continuations = o.runs.filter(row => row.agentId === worker?.id && row.id !== s.workerRunId);
  const targetHandled = handledInTurn(receipts, queued.find(row => row.id === s.targetId)), owed = queued.filter(row => !handledInTurn(receipts, row));
  const consumedInTurn = queued.length === 2 && owed.length === 0 && continuations.length === 0 && o.runs.length === 2 && s.inTurnOutcomeApplied === true;
  const consumedByContinuation = owed.length > 0 && continuations.length === 1 && s.consumingRunCount === 1 && s.nativeDeliveryBound === true && o.runs.length === 3
    && s.continuationWarnedEarlierReads === true && (targetHandled ? s.inTurnOutcomeSaved === true && s.latestOutcomeKept === true : s.finalOutcomeApplied === true);
  c.add("edited-message-consumed-once", queued.length === 2 && queued[0]?.id === s.targetId && (consumedInTurn || consumedByContinuation)
    && s.queueEmptyAfterDelivery === true && s.taskDone === true && o.runs.every(row => row.status === "succeeded") && s.initialRevisionRetained === true,
  "The edited message is consumed exactly once: the running turn read its current revision, saved the change and cited it as handled with no continuation, or one ordinary continuation receives every message not handled in turn, in its final order, and that continuation saves the latest revision.");
  return c.result();
}

export const runtimeQueueControlCases = [runtimeDefinition("steering.edit-queued-message", ctx => humanQueuedRuntime(ctx), gradeQueueEdit, {
  sourceFiles: ["chat-catalog-domains/runtime-queue-controls.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-rendered-links.ts", "chat-scenarios/steering.yaml"],
  oracleVersion: "paperclip.chat-catalog.edit-queued-message.structural.v7",
  authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2, attemptTimeoutMs: 720_000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 2 }, maximumTerminalStatusCounts: { succeeded: 3 } },
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  async act(ctx, state) {
    await pollUntil({ label: "Canonical editing guidance while the real worker remains active", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running")
        && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    // The finished run and waiting chat precede the saved reply's render; read its links only after it renders.
    await waitForTurnReplyLinks(ctx);
    const answered = await observeRuntime(ctx, state); state.queryReply = answered.reply; state.queryLinks = answered.links; const source = ctx.input.page.url();
    const initial = await queue(ctx, state), targetId = String(state.targetId), mutation = `${endpoint(state)}/${targetId}`;
    state.queueAtReply = initial;
    state.agentEditStatus = await probeAgentPermission(ctx, mutation, "PATCH", { queueId: initial.queueId, revision: initial.revision, body: blueText });
    state.agentOrderStatus = await probeAgentPermission(ctx, `${endpoint(state)}/order`, "PUT", { queueId: initial.queueId, revision: initial.revision, orderedCommentIds: initial.entries.map(row => row.comment.id).reverse() });
    await ctx.input.page.goto(taskUrl(ctx, state), { waitUntil: "domcontentloaded" });
    await edit(ctx.input.page, targetId, blueText);
    // Hold a real old-revision PATCH before admission. A second human tab then
    // saves the competing revision through the ordinary supported control.
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { arrived = resolve; });
    let first = true; const pattern = `**${mutation}`;
    await ctx.input.page.route(pattern, async route => {
      if (route.request().method() === "PATCH" && first) { first = false; arrived(); await held; }
      await route.continue();
    });
    const concurrent = await ctx.input.page.context().newPage();
    try {
      const saving = ctx.input.page.getByRole("button", { name: "Save queued message", exact: true }).click();
      await Promise.all([intercepted, saving]);
      await concurrent.goto(taskUrl(ctx, state), { waitUntil: "domcontentloaded" });
      await edit(concurrent, targetId, `${redText} ${state.concurrentMarker}`);
      await concurrent.getByRole("button", { name: "Save queued message", exact: true }).click();
      await pollUntil({ label: "Concurrent human edit persisted", deadlineAt: Date.now() + 15_000, load: () => queue(ctx, state),
        accept: q => q.entries.some(row => row.comment.id === targetId && row.comment.body === `${redText} ${state.concurrentMarker}`) });
      const rejected = ctx.input.page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === mutation);
      release(); state.concurrentStatus = (await rejected).status(); await saving;
      await expect(ctx.input.page.getByText(/queue.*changed|changed.*queue|revision|refresh|try again/i).first()).toBeVisible(); state.concurrentErrorVisible = true;
      state.concurrentSaveRetained = (await queue(ctx, state)).entries.some(row => row.comment.id === targetId && row.comment.body === `${redText} ${state.concurrentMarker}`);
    } finally { release(); await ctx.input.page.unroute(pattern); await concurrent.close(); }
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await edit(ctx.input.page, targetId, `${blueText} ${state.concurrentMarker}`);
    const saved = ctx.input.page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === mutation, { timeout: 15_000 });
    await ctx.input.page.getByRole("button", { name: "Save queued message", exact: true }).click();
    state.finalEditStatus = (await saved).status();
    if (state.finalEditStatus !== 200) throw new Error(`The person's final queued edit was not saved (${state.finalEditStatus})`);
    state.queueAfterEdit = await pollUntil({ label: "The saved edit is the queue's current revision", deadlineAt: Date.now() + 15_000, load: () => queue(ctx, state),
      accept: q => q.entries.some(row => row.comment.id === targetId && row.comment.body === `${blueText} ${state.concurrentMarker}` && row.position === 1) });
    const handle = ctx.input.page.getByRole("button", { name: `Reorder queued message: ${blueText} ${state.concurrentMarker}`, exact: true });
    await expect(handle).toBeVisible();
    state.reorderRequest = await keyboardMoveQueuedMessageUp(ctx.input.page, handle, 15_000, 100, { attempts: 2, beforeRetry: async () => {
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(handle).toBeVisible();
    } });
    if ((state.reorderRequest as { status: number }).status !== 200) throw new Error(`The person's reorder was refused (${(state.reorderRequest as { status: number }).status})`);
    state.queueAfter = await pollUntil({ label: "Actual full blue text and first queue position persisted", deadlineAt: Date.now() + 15_000,
      load: () => queue(ctx, state), accept: q => q.entries[0]?.comment.id === targetId && q.entries[0]?.comment.body === `${blueText} ${state.concurrentMarker}` });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await edit(ctx.input.page, targetId, `${blueText} ${state.concurrentMarker}`);
    const pending = state.queueAfter as IssueQueuedCommentQueue;
    await writeFile((state.gate as { gate: string }).gate, "The human brief is ready. Save the current website brief as a task document, then finish this turn normally.", "utf8");
    const consumedInTurn = settledQueue((v: { runs: Array<{ status: string }>; queue: IssueQueuedCommentQueue; task: Entity }) => v.runs.length === 2
      && v.runs.every(row => row.status === "succeeded") && v.queue.entries.length === 0 && v.task.status === "done", 30_000);
    const delivered = await pollUntil({ label: "Edited messages are consumed once, in the running turn or one ordinary continuation", deadlineAt: Date.now() + 300_000,
      load: async () => ({ runs: await ctx.allRuns(), queue: await queue(ctx, state), task: await ctx.input.api.get<Entity>(`/api/issues/${(state.task as Entity).id}`) }),
      accept: v => consumedInTurn(v) || v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") && v.queue.entries.length === 0 && v.task.status === "done",
      reject: v => v.runs.length > 3 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The declared edited-message delivery failed or duplicated work" : undefined });
    await expect(ctx.input.page.getByText("Queued message changed", { exact: true })).toBeVisible();
    await expect(ctx.input.page.getByRole("button", { name: "Queue as new message", exact: true })).toBeVisible(); state.dispatchedWarningVisible = true;
    state.dispatchedStatus = await probeConsumedHumanQueue(ctx, String(state.humanId), mutation, "PATCH", { queueId: pending.queueId, revision: pending.revision, body: "Late stale edit must not replace history" });
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${(state.task as Entity).id}/comments?order=asc`);
    state.originalCommentStillReadable = comments.some(row => row.id === targetId && row.body === `${blueText} ${state.concurrentMarker}` && row.authorUserId === state.humanId);
    const otherId = initial.entries.find(row => row.comment.id !== targetId)?.comment.id;
    state.queuedComments = [targetId, otherId].map(id => comments.find(row => row.id === id)).filter(Boolean).map(row => ({ id: row!.id, updatedAt: row!.updatedAt, body: row!.body }));
    const receipts = await runCommentReceipts(ctx, String(state.workerRunId)); state.workerCommentReceipts = receipts;
    const unread = (state.queuedComments as Array<{ id: string; updatedAt?: unknown; body?: string }>).filter(row => !handledInTurn(receipts, row));
    const consumers = delivered.runs.filter(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId);
    const run = consumers[0] && await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[]; paperclipWake?: { comments?: Array<{ id?: string; readByEarlierTurn?: boolean }> } }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${consumers[0].id}`);
    state.continuationWarnedEarlierReads = unread.every(row => !readCurrentRevision(receipts.reads, row) || wakeMarksEarlierRead(run?.contextSnapshot, row.id));
    const ids = run?.contextSnapshot?.wakeCommentIds ?? [], prompt = run?.runnerProfileJson?.nativeExecutionInput?.task?.prompt ?? "";
    state.consumingRunCount = consumers.length; state.consumerRunId = consumers[0]?.id ?? null; state.nativeDeliveryBound = unread.length > 0 && JSON.stringify(ids) === JSON.stringify(unread.map(row => row.id))
      && unread.every(row => prompt.includes(String(row.body)));
    state.queueEmptyAfterDelivery = delivered.queue.entries.length === 0; state.taskDone = delivered.task.status === "done";
    await ctx.input.capture("actual-queued-edit-stale-dispatch", "Consumed human direction remains history and stale editing offers a new message", "runtime-queued-edit.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.initialRevisionRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && row.createdByAgentId === (state.worker as Entity).id);
    const blue = o.revisions.filter(row => row.createdByRunId === state.workerRunId && row.createdByAgentId === (state.worker as Entity).id && /\bblue\b/i.test(row.body ?? ""));
    const latest = (row: Entity) => o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id);
    state.inTurnOutcomeApplied = blue.some(latest); state.inTurnOutcomeSaved = blue.length > 0;
    state.finalOutcomeApplied = !!state.consumerRunId && o.revisions.some(row => row.createdByRunId === state.consumerRunId && row.createdByAgentId === (state.worker as Entity).id && latest(row));
    state.latestOutcomeKept = blue.some(saved => o.revisions.some(row => row.documentId === saved.documentId && latest(row) && /\bblue\b/i.test(row.body ?? "")));
    return o;
  },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); } },
})];
