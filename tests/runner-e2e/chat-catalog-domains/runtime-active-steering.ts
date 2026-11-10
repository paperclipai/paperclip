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
import { runtimeDefinition, observeRuntime, runtimeObservation } from "./runtime-support.js";
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
export function gradeActiveSteering(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-native-steering-context", !!o, "A genuine compatible active native run and saved human message are required."); if (!o) return c.result();
  const s = o.state, before = s.queueBefore as IssueQueuedCommentQueue, after = s.queueAfterAction as IssueQueuedCommentQueue;
  const entry = before?.entries.find(row => row.comment.id === s.targetId);
  c.add("saved-owned-message-compatible-active-target", !!entry && entry.comment.body === direction && entry.comment.authorUserId === s.humanId && !entry.comment.authorAgentId
    && before.entries.length === 1 && before.issueId === (s.task as Entity).id && before.targetRunId === s.workerRunId && before.protocol === "paperclip_runner_v1"
    && before.steeringDisposition === "available" && s.workerWasReallyWaiting === true,
  "The actual harness advertises steering for the exact saved human-owned message and running task, before the canonical request.");
  c.add("explicit-human-control-and-truthful-guidance", s.humanSteerSelected === true && s.agentSteerStatus === 403
    && /steer|steering/i.test(String(s.queryReply)) && !/I(?:'ve| have)? (?:already )?(?:steered|delivered|implemented)|blue (?:design|page) (?:is|has been) (?:ready|complete)/i.test(String(s.queryReply)),
  "Chat identifies the supported human Steer control; it cannot forge the action or claim queue admission already changed the active result.");
  const accepted = s.steerStatus === 200;
  c.add("delivery-distinct-from-queue-with-no-loss", s.steerObservedBranch === (accepted ? "same-run-acknowledged" : "provider-rejected-normal-continuation") && (accepted
    ? s.acknowledgedSameRun === true && after?.entries.length === 0 && s.steerAuditBound === true && s.idempotentRetryStatus === 200 && s.ordinaryConsumerCount === 0
    : ["steering_rejected", "steering_unsupported"].includes(String(s.steerFailureCode)) && s.steerStatus === 409 && s.providerFailureVisible === true && s.failureRetainedMessage === true && after?.entries.some(row => row.comment.id === s.targetId && row.comment.body === direction) === true
      && s.supportedContinuationVisible === true && s.ordinaryConsumerCount === 1 && s.continuationInputBound === true),
  "A durable same-run ACK is required for delivery; an actual provider rejection instead retains the exact message and visible failure until one normal continuation consumes it.");
  c.add("actual-blue-output-correct-native-owner", s.actualBlueArtifact === true && s.blueRevisionBound === true && s.workerTaskDone === true && s.queueEmptyAtEnd === true
    && o.runs.length === (accepted ? 2 : 3) && o.runs.every(row => row.status === "succeeded") && o.tasks.length === 1,
  "Actual delivered HTML and its task revision reflect blue under the correct consuming native run, with no duplicate work or hidden run.");
  return c.result();
}
export const runtimeActiveSteeringCases = [runtimeDefinition("steering.steer-active", async ctx => {
  const state: Record<string, unknown> = await busyRuntimeWorker(ctx), task = state.task as Entity, source = ctx.input.page.url();
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  await submitTaskReply(ctx.input.page, direction);
  const before = await pollUntil({ label: "Actual native same-turn steering advertised for saved human blue message", deadlineAt: Date.now() + 30_000,
    load: () => ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`),
    accept: q => q.entries.length === 1 && q.entries[0]?.comment.body === direction && q.targetRunId === state.workerRunId && q.protocol === "paperclip_runner_v1" && q.steeringDisposition === "available" });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (before.entries[0]?.comment.authorUserId !== session.user.id || before.entries[0].comment.authorAgentId) throw new Error("Steering fixture lacks actual human message ownership");
  await expect(ctx.input.page.getByTestId(`task-chat-queued-steer-${before.entries[0].comment.id}`)).toBeEnabled();
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { ...state, humanId: session.user.id, queueBefore: before, targetId: before.entries[0].comment.id };
}, gradeActiveSteering, {
  authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2, attemptTimeoutMs: 720_000,
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  sourceFiles: ["chat-catalog-domains/runtime-active-steering.ts", "chat-catalog-domains/runtime-rendered-artifact.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "registered-artifact.ts", "chat-scenarios/steering.yaml"],
  async act(ctx, state) {
    await pollUntil({ label: "Canonical steering guidance while the original native owner remains active", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running")
        && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity, endpoint = `/api/issues/${task.id}/queued-comments`, targetId = String(state.targetId);
    const before = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint);
    if (before.entries.length !== 1 || before.entries[0]?.comment.id !== targetId || before.targetRunId !== state.workerRunId) throw new Error("Canonical guidance lost or duplicated the saved human direction");
    const mutation = { queueId: before.queueId, revision: before.revision, targetRunId: before.targetRunId };
    state.agentSteerStatus = await probeAgentPermission(ctx, `${endpoint}/${targetId}/steer`, "POST", mutation);
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
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
    await ctx.input.evidence("runtime-steering-observed-branch.json", { branch: state.steerObservedBranch, failureCode: state.steerFailureCode ?? null, status: state.steerStatus, issueId: task.id, runId: state.workerRunId, commentId: targetId, otherBranchLiveQualified: false });
    await ctx.input.capture("actual-steering-delivery", "Selected human steering action and actual native delivery or retained rejection", "runtime-steer-active.png");
    await writeFile((state.gate as { gate: string }).gate, "The human brief is ready. Implement a small semantic website.html using the actual design direction you received, with a visible h1 and a labelled signup action. Register the real website.html file as a downloadable artifact work product. Save the actual chosen color and design in a non-plan website-delivery task document, then complete normally. Preserve saved human requirements for normal admission; do not create tasks or publish externally.", "utf8");
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
    if (state.outputRunId) {
      const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, String(state.outputRunId), ["website.html"]);
      if (artifact?.contentVerified) {
        state.actualBlueArtifact = hasVisibleBlueDesign(await renderRuntimeArtifact(ctx, artifact.content));
      }
      state.blueRevisionBound = o.revisions.some(row => row.createdByRunId === state.outputRunId && row.createdByAgentId === (state.worker as Entity).id && /blue/i.test(row.body ?? "")
        && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
    }
    return o;
  },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-queued-messages")).toHaveCount(0); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); } },
})];
