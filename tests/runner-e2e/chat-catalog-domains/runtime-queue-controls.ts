import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeQueueCases } from "./runtime-queue.js";
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
  c.add("chat-guides-human-control-without-forging", /queue|pending|waiting/i.test(String(s.queryReply)) && /edit|control|menu|reorder|first/i.test(String(s.queryReply))
    && !/I(?:'ve| have)? (?:already )?(?:edited|changed|reordered)/i.test(String(s.queryReply)) && s.agentEditStatus === 403 && s.agentOrderStatus === 403,
  "The canonical reply identifies the human queue controls and the actual agent cannot impersonate the person's edits or reorder.");
  c.add("concurrent-edit-rejects-stale-request-visibly", s.concurrentStatus === 409 && s.concurrentErrorVisible === true && s.concurrentSaveRetained === true,
    "An actual held old-revision human request loses to a real second-session edit and shows its conflict, retaining the winner's text.");
  c.add("dispatched-edit-is-visible-new-direction", s.dispatchedStatus === 409 && s.dispatchedWarningVisible === true && s.originalCommentStillReadable === true,
    "After actual dispatch, the old edit rejects and the real composer offers a new message rather than rewriting consumed history.");
  c.add("exactly-one-normal-native-consumer", s.nativeDeliveryBound === true && s.queueEmptyAfterDelivery === true && o.runs.length === 3
    && o.runs.every(row => row.status === "succeeded") && s.consumingRunCount === 1 && s.initialRevisionRetained === true,
  "One actual ordinary continuation receives the edited message once, in its final order, while original work remains preserved.");
  return c.result();
}

export const runtimeQueueControlCases = [runtimeDefinition("steering.edit-queued-message", ctx => humanQueuedRuntime(ctx), gradeQueueEdit, {
  sourceFiles: ["chat-catalog-domains/runtime-queue-controls.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/steering.yaml"],
  authentication: "human-session", expectedRunCount: 3, attemptTimeoutMs: 720_000,
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  async act(ctx, state) {
    await pollUntil({ label: "Canonical editing guidance while the real worker remains active", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running")
        && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply; const source = ctx.input.page.url();
    const initial = await queue(ctx, state), targetId = String(state.targetId), mutation = `${endpoint(state)}/${targetId}`;
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
    await ctx.input.page.getByRole("button", { name: "Save queued message", exact: true }).click();
    const handle = ctx.input.page.getByRole("button", { name: `Reorder queued message: ${blueText} ${state.concurrentMarker}`, exact: true });
    await handle.focus(); await handle.press("Space"); await handle.press("ArrowUp"); await handle.press("Space");
    state.queueAfter = await pollUntil({ label: "Actual full blue text and first queue position persisted", deadlineAt: Date.now() + 15_000,
      load: () => queue(ctx, state), accept: q => q.entries[0]?.comment.id === targetId && q.entries[0]?.comment.body === `${blueText} ${state.concurrentMarker}` });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await edit(ctx.input.page, targetId, `${blueText} ${state.concurrentMarker}`);
    const pending = state.queueAfter as IssueQueuedCommentQueue;
    await writeFile((state.gate as { gate: string }).gate, "The human brief is ready. Save the current website brief as a task document, then finish this turn normally. Leave saved follow-up directions intact for the normal continuation.", "utf8");
    const delivered = await pollUntil({ label: "Edited messages reach one ordinary native continuation", deadlineAt: Date.now() + 240_000,
      load: async () => ({ runs: await ctx.allRuns(), queue: await queue(ctx, state), task: await ctx.input.api.get<Entity>(`/api/issues/${(state.task as Entity).id}`) }),
      accept: v => v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") && v.queue.entries.length === 0 && v.task.status === "done",
      reject: v => v.runs.length > 3 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The declared edited-message delivery failed or duplicated work" : undefined });
    await expect(ctx.input.page.getByText("Queued message changed", { exact: true })).toBeVisible();
    await expect(ctx.input.page.getByRole("button", { name: "Queue as new message", exact: true })).toBeVisible(); state.dispatchedWarningVisible = true;
    state.dispatchedStatus = await probeConsumedHumanQueue(ctx, String(state.humanId), mutation, "PATCH", { queueId: pending.queueId, revision: pending.revision, body: "Late stale edit must not replace history" });
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${(state.task as Entity).id}/comments?order=asc`);
    state.originalCommentStillReadable = comments.some(row => row.id === targetId && row.body === `${blueText} ${state.concurrentMarker}` && row.authorUserId === state.humanId);
    const consumers = delivered.runs.filter(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId);
    const run = consumers[0] && await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[] }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${consumers[0].id}`);
    const ids = run?.contextSnapshot?.wakeCommentIds ?? [], prompt = run?.runnerProfileJson?.nativeExecutionInput?.task?.prompt ?? "";
    state.consumingRunCount = consumers.length; state.nativeDeliveryBound = ids.length === 2 && ids[0] === targetId
      && ids[1] === initial.entries.find(row => row.comment.id !== targetId)?.comment.id && prompt.includes(`${blueText} ${state.concurrentMarker}`) && prompt.includes(otherText);
    state.queueEmptyAfterDelivery = delivered.queue.entries.length === 0;
    await ctx.input.capture("actual-queued-edit-stale-dispatch", "Consumed human direction remains history and stale editing offers a new message", "runtime-queued-edit.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.initialRevisionRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && row.createdByAgentId === (state.worker as Entity).id);
    return o;
  },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); } },
})];
