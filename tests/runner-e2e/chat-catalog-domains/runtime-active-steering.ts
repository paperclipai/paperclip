import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { renderRuntimeArtifact } from "./runtime-rendered-artifact.js";
import { runtimeQueueCases } from "./runtime-queue.js";
import { deliveryRevisionBound } from "./runtime-interruption.js";
import { runtimeDefinition, observeRuntime, runtimeObservation } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
export function isBlueColor(color: string) {
  const parts = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i);
  if (!parts) return false;
  const [, red, green, blue] = parts.map(Number);
  const alpha = color.match(/^rgba?\([^)]*[,/]\s*(\d*(?:\.\d+)?)\s*\)$/i);
  if (/^rgba\(/i.test(color) && (!alpha || Number(alpha[1]) < 0.25)) return false;
  return blue! >= 64 && blue! > red! + 24 && blue! >= green!;
}
export function hasVisibleBlueDesign(elements: Array<{ tag: string; role?: string | null; color: string; background: string }>) {
  return elements.some(element => ["BODY", "MAIN", "SECTION", "HEADER", "H1", "H2", "H3", "BUTTON"].includes(element.tag) || element.role === "button"
    ? isBlueColor(element.background) || element.tag !== "BODY" && isBlueColor(element.color) : false);
}
const direction = "Switch to a blue design while you are working.";
/** Branch a run must take, decided by what the harness actually advertised and how the product answered. */
export function steeringBranch(disposition: unknown, steerStatus: unknown) {
  return disposition === "unsupported" ? "unsupported-queued-normal-continuation" : disposition !== "available" ? "not-advertised"
    : steerStatus === 200 ? "same-run-acknowledged" : "provider-rejected-normal-continuation";
}
export function gradeActiveSteering(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-native-steering-context", !!o, "A genuine active native run and saved human message are required."); if (!o) return c.result();
  const s = o.state, before = s.queueBefore as IssueQueuedCommentQueue, after = s.queueAfterAction as IssueQueuedCommentQueue;
  const entry = before?.entries.find(row => row.comment.id === s.targetId), unsupported = before?.steeringDisposition === "unsupported";
  c.add("saved-owned-message-honest-active-target", !!entry && entry.comment.body === direction && entry.comment.authorUserId === s.humanId && !entry.comment.authorAgentId
    && before.entries.length === 1 && before.issueId === (s.task as Entity).id && before.targetRunId === s.workerRunId && before.protocol === "paperclip_runner_v1"
    && ["available", "unsupported"].includes(before.steeringDisposition) && s.workerWasReallyWaiting === true
    && (unsupported ? s.steerControlEnabled === false && s.continuationControlVisible === true : s.steerControlEnabled === true),
  "The running task's queue states the harness's real steering capability for the exact saved human message: an enabled Steer control when it can steer, otherwise no usable Steer control and a visible supported continuation control.");
  const branch = steeringBranch(before?.steeringDisposition, s.steerStatus), accepted = branch === "same-run-acknowledged";
  c.add("human-only-control-without-forged-delivery", s.agentSteerStatus === 403 && (unsupported ? s.humanSteerAttempted === true : s.humanSteerSelected === true),
  "Only the person's own action can steer the message; the agent's attempt is refused.");
  const retained = after?.entries.some(row => row.comment.id === s.targetId && row.comment.body === direction) === true;
  c.add("delivery-distinct-from-queue-with-no-loss", s.steerObservedBranch === branch && (accepted
    ? s.acknowledgedSameRun === true && after?.entries.every(row => row.comment.authorAgentId === o.leadId) === true && s.steerAuditBound === true && s.idempotentRetryStatus === 200 && s.ordinaryConsumerCount === 0
    : branch === "unsupported-queued-normal-continuation"
      ? s.steerStatus === 409 && s.steerFailureCode === "steering_unsupported" && s.steeredActivityCount === 0 && retained && s.unsupportedStateRetained === true
        && s.ordinaryConsumerCount === 1 && s.continuationInputBound === true
      : branch === "provider-rejected-normal-continuation" && ["steering_rejected", "steering_unsupported"].includes(String(s.steerFailureCode)) && s.steerStatus === 409 && s.providerFailureVisible === true
        && s.failureRetainedMessage === true && retained && s.supportedContinuationVisible === true && s.ordinaryConsumerCount === 1 && s.continuationInputBound === true),
  "A durable same-run ACK is required for delivery; a runtime that cannot steer (or a provider rejection) instead keeps the exact message visibly queued, records no steering, and one normal continuation consumes it.");
  c.add("actual-blue-output-correct-native-owner", s.actualBlueArtifact === true && s.deliveryRevisionBound === true && s.workerTaskDone === true && s.queueEmptyAtEnd === true
    && o.runs.length === (accepted && !Number(s.leadRelayCount) ? 2 : 3) && o.runs.every(row => row.status === "succeeded") && o.tasks.length === 1,
  "Actual delivered HTML renders blue, and the consuming native run saved its task delivery document, with no duplicate work or hidden run.");
  return c.result();
}
/** What the person can actually do with the queued message: an enabled Steer control, or the supported continuation (Interrupt) control. */
async function queuedSteeringControls(ctx: ChatCatalogContext, targetId: string, disposition: string) {
  const steer = ctx.input.page.getByTestId(`task-chat-queued-steer-${targetId}`), next = ctx.input.page.getByTestId(`task-chat-queued-interrupt-${targetId}`);
  // The page reads the same queue the API returned; wait for the control that capability implies, then record both.
  await expect(disposition === "available" ? steer : next).toBeEnabled();
  return { steerControlEnabled: await steer.count() > 0 && await steer.first().isEnabled(), continuationControlVisible: await next.count() > 0 && await next.first().isEnabled() };
}
export const runtimeActiveSteeringCases = [runtimeDefinition("steering.steer-active", async ctx => {
  const state: Record<string, unknown> = await busyRuntimeWorker(ctx), task = state.task as Entity, source = ctx.input.page.url();
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  await submitTaskReply(ctx.input.page, direction);
  const before = await pollUntil({ label: "Running task queue states its harness steering capability for the saved human blue message", deadlineAt: Date.now() + 30_000,
    load: () => ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`),
    accept: q => q.entries.length === 1 && q.entries[0]?.comment.body === direction && q.targetRunId === state.workerRunId && q.protocol === "paperclip_runner_v1"
      && ["available", "unsupported"].includes(q.steeringDisposition) });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (before.entries[0]?.comment.authorUserId !== session.user.id || before.entries[0].comment.authorAgentId) throw new Error("Steering fixture lacks actual human message ownership");
  const targetId = before.entries[0].comment.id;
  await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${targetId}`)).toBeVisible();
  const controls = await queuedSteeringControls(ctx, targetId, before.steeringDisposition);
  if (before.steeringDisposition === "available" ? !controls.steerControlEnabled : controls.steerControlEnabled || !controls.continuationControlVisible)
    throw new Error("The queued message controls contradict the advertised steering capability");
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { ...state, humanId: session.user.id, queueBefore: before, targetId, ...controls };
}, gradeActiveSteering, {
  authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2, attemptTimeoutMs: 720_000, oracleVersion: "paperclip.chat-catalog.runtime.steer-active.v5",
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  sourceFiles: ["chat-catalog-domains/runtime-active-steering.ts", "chat-catalog-domains/runtime-rendered-artifact.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-interruption.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "registered-artifact.ts", "chat-scenarios/steering.yaml"],
  async act(ctx, state) {
    await pollUntil({ label: "Canonical steering guidance while the original native owner remains active", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running")
        && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity, endpoint = `/api/issues/${task.id}/queued-comments`, targetId = String(state.targetId);
    const before = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint);
    // The chat lead may relay the direction as its own task comment; that queues beside the person's message and is not theirs to steer.
    const human = before.entries.filter(row => !row.comment.authorAgentId), relays = before.entries.filter(row => row.comment.authorAgentId === ctx.input.fixtures.agent.id);
    if (human.length !== 1 || human[0]?.comment.id !== targetId || human.length + relays.length !== before.entries.length || before.targetRunId !== state.workerRunId)
      throw new Error("Canonical guidance lost or duplicated the saved human direction");
    state.leadRelayCount = relays.length;
    const mutation = { queueId: before.queueId, revision: before.revision, targetRunId: before.targetRunId };
    state.agentSteerStatus = await probeAgentPermission(ctx, `${endpoint}/${targetId}/steer`, "POST", mutation);
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    if ((state.queueBefore as IssueQueuedCommentQueue).steeringDisposition === "unsupported") {
      // This harness cannot steer, and the page offers no Steer control. Attempt it once with the person's own session to
      // prove the product refuses rather than claiming delivery, then leave the message for normal admission.
      const attempt = await ctx.input.page.request.post(`${endpoint}/${targetId}/steer`, { data: mutation }); state.humanSteerAttempted = true;
      state.steerStatus = attempt.status(); const body = await attempt.json().catch(() => ({})) as { code?: string; details?: { code?: string } }; await attempt.dispose();
      state.steerFailureCode = body.code ?? body.details?.code; state.steerObservedBranch = steeringBranch("unsupported", state.steerStatus);
      const after = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint); state.queueAfterAction = after;
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${targetId}`)).toBeVisible();
      const controls = await queuedSteeringControls(ctx, targetId, after.steeringDisposition);
      state.unsupportedStateRetained = after.steeringDisposition === "unsupported" && after.targetRunId === state.workerRunId && !controls.steerControlEnabled && controls.continuationControlVisible;
    } else {
      const response = ctx.input.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `${endpoint}/${targetId}/steer`);
      await ctx.input.page.getByTestId(`task-chat-queued-steer-${targetId}`).click(); state.humanSteerSelected = true;
      const result = await response; state.steerStatus = result.status();
      const after = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint); state.queueAfterAction = after;
      if (result.status() === 200) {
        state.steerObservedBranch = "same-run-acknowledged";
        const run = await ctx.input.api.get<{ resultJson?: { queuedSteeringAcknowledgements?: Record<string, { status?: string; queueId?: string; turnId?: string }> } }>(`/api/heartbeat-runs/${state.workerRunId}`);
        const ack = run.resultJson?.queuedSteeringAcknowledgements?.[targetId];
        state.acknowledgedSameRun = ack?.status === "acknowledged" && ack.queueId === before.queueId && typeof ack.turnId === "string" && ack.turnId.length > 0;
        const retry = await ctx.input.page.request.post(`${endpoint}/${targetId}/steer`, { data: mutation }); state.idempotentRetryStatus = retry.status(); await retry.dispose();
      } else {
        if (result.status() !== 409) throw new Error("Steering failed outside its supported visible rejection contract");
        state.steerObservedBranch = "provider-rejected-normal-continuation";
        const body = await result.json() as { code?: string; details?: { code?: string } };
        state.steerFailureCode = body.code ?? body.details?.code;
        if (!["steering_rejected", "steering_unsupported"].includes(String(state.steerFailureCode))) throw new Error("A non-provider queue conflict does not qualify as a provider steering rejection");
        await expect(ctx.input.page.getByText(/steer|temporarily unavailable|timed out/i).filter({ hasNot: ctx.input.page.locator("button") }).first()).toBeVisible();
        state.providerFailureVisible = true; state.failureRetainedMessage = after.entries.some(row => row.comment.id === targetId && row.comment.body === direction);
        await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${targetId}`)).toBeVisible();
        await expect(ctx.input.page.getByTestId("task-chat-composer-input").last()).toBeVisible(); state.supportedContinuationVisible = true;
      }
    }
    await ctx.input.evidence("runtime-steering-observed-branch.json", { branch: state.steerObservedBranch, failureCode: state.steerFailureCode ?? null, status: state.steerStatus, issueId: task.id, runId: state.workerRunId, commentId: targetId, otherBranchLiveQualified: false });
    await ctx.input.capture("actual-steering-delivery", "Selected human steering action and actual native delivery or retained rejection", "runtime-steer-active.png");
    const build = "Implement a small semantic website.html with a visible h1 and a labelled signup action, register the real website.html file as a downloadable artifact work product, and save the actual chosen color and design in a non-plan website-delivery task document.";
    // Delivered same-turn direction is built now; a direction still queued reaches the next normal turn, which applies it to the same deliverable.
    await writeFile((state.gate as { gate: string }).gate, state.steerStatus === 200
      ? `The human brief is ready. ${build} Use the actual design direction you received, then complete normally. Preserve saved human requirements for normal admission; do not create tasks or publish externally.`
      : `The human brief is ready. ${build} Then finish this current turn normally. Keep human requirements queued by Paperclip intact for normal delivery; when one arrives, apply it to website.html, register the updated file, update the delivery document, and complete the task. Do not create tasks or publish externally.`, "utf8");
    const finished = await pollUntil({ label: "Actual selected steering or preserved normal continuation produces its website", deadlineAt: Date.now() + 240_000,
      load: async () => ({ runs: await ctx.allRuns(), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`) }),
      accept: v => v.task.status === "done" && v.queue.entries.length === 0 && v.runs.length === (state.steerStatus === 200 ? 2 : 3) && v.runs.every(row => row.status === "succeeded"),
      reject: v => v.runs.length > 3 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Steered work failed or admitted an undeclared execution" : undefined });
    const successors = finished.runs.filter(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId);
    state.ordinaryConsumerCount = successors.length; state.outputRunId = state.steerStatus === 200 ? state.workerRunId : successors[0]?.id;
    if (successors.length === 1) {
      const full = await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[] }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${successors[0]!.id}`);
      state.continuationInputBound = full.contextSnapshot?.wakeCommentIds?.filter(id => id === targetId).length === 1 && full.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(direction) === true;
    }
    state.workerTaskDone = finished.task.status === "done"; state.queueEmptyAtEnd = finished.queue.entries.length === 0;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state), task = state.task as Entity;
    state.steerAuditBound = o.activity.some(row => row.action === "issue.queued_comment_steered" && row.entityId === task.id && row.actorId === state.humanId
      && row.details?.commentId === state.targetId && row.details?.targetRunId === state.workerRunId && row.details?.duplicate === false);
    state.steeredActivityCount = o.activity.filter(row => row.action === "issue.queued_comment_steered" && row.entityId === task.id).length;
    if (state.outputRunId) {
      const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, String(state.outputRunId), ["website.html"]);
      if (artifact?.contentVerified) {
        state.actualBlueArtifact = hasVisibleBlueDesign(await renderRuntimeArtifact(ctx, artifact.content));
      }
      // The rendered page proves the colour; the document must be the requested website-delivery record, current at the consuming run's revision.
      state.deliveryRevisionBound = deliveryRevisionBound(o, task.id, String(state.outputRunId), (state.worker as Entity).id);
    }
    return o;
  },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-queued-messages")).toHaveCount(0); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); } },
})];
