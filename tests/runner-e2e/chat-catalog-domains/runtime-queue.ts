import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pollUntil } from "../api.js";
import { checks, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
import type { IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
export function gradeQueuedFollowup(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-queue-and-delivery-evidence", !!o, "The actual task queue, saved requirement, real initial worker and later consuming native input are required."); if (!o) return c.result();
  const task = o.state.task as Entity; const queued = o.state.queuedAtReply as IssueQueuedCommentQueue | undefined;
  const requirement = queued?.entries.find(entry => /contact/i.test(entry.comment.body));
  c.add("correct-task-ordered-waiting-requirement-once", !!queued && queued.issueId === task.id && ["queued", "deferred"].includes(queued.state ?? "")
    && queued.entries.length === 1 && requirement?.position === 0 && o.state.workerStatusAtReply === "running"
    && requirement.comment.authorAgentId === o.leadId && (requirement.comment as typeof requirement.comment & { createdByRunId?: string }).createdByRunId === o.state.canonicalRunId,
  "Exactly one contact-section instruction is durably queued in order on the genuine running Website task and attributed to the source controller turn.");
  c.add("honest-not-consumed-yet", /queue|sav|forward|wait|next|follow.up|pending/i.test(String(o.state.queryReply))
    && !/already (?:implemented|consumed|added)|contact section (?:is|has been) (?:ready|added|complete)|I(?:'ve| have)? implemented/i.test(String(o.state.queryReply)),
  "The canonical answer describes pending delivery rather than pretending an active worker already consumed or implemented it.");
  c.add("normal-continuation-consumes-exact-input-once", !!requirement && o.state.consumedCommentId === requirement.comment.id
    && o.state.deliveryNativeInputBound === true && o.state.consumingRunCount === 1 && o.state.queueEmptyAfterDelivery === true
    && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded")
    && o.runs.filter(run => run.agentId === (o.state.worker as Entity).id).length === 2,
  "The same saved requirement is consumed by one ordinary successor native turn after the real prior owner settles.");
  c.add("earlier-work-and-contact-result-retained", o.state.initialBriefRevisionRetained === true && o.state.contactResultRevision === true
    && o.tasks.length === 1 && o.tasks[0]?.id === task.id && o.tasks[0]?.assigneeAgentId === (o.state.worker as Entity).id && o.tasks[0]?.status === "done",
  "The original worker's saved brief revision remains inspectable and the successor saves an actual contact-section result on the same task.");
  return c.result();
}
export const runtimeQueueCases = [runtimeDefinition("steering.queue-follow-up", busyRuntimeWorker, gradeQueuedFollowup, {
  sourceFiles: ["chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/steering.yaml"],
  expectedRunCount: 3, attemptTimeoutMs: 720_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-busy-worker", "worker-task-scope"] },
  async verifySetup(ctx, state) {
    const c = checks(); const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const worker = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${(state.worker as Entity).id}`); const run = (await ctx.allRuns()).find(row => row.id === state.workerRunId);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual controller is admitted normally.");
    c.add("real-busy-worker", worker.lifecycleState === "ready" && ["active", "running"].includes(worker.status ?? "") && run?.status === "running" && state.workerWasReallyWaiting === true,
    "Morgan is genuinely busy in a native tool wait, without a fabricated busy state.");
    c.add("worker-task-scope", run?.agentId === worker.id && run.companyId === ctx.input.fixtures.company.id
      && [run.contextSnapshot?.issueId, (run as typeof run & { nativeIssueId?: string })?.nativeIssueId].includes((state.task as Entity).id), "The actual active owner belongs to the exact task and company.");
    return c.result();
  },
  async act(ctx, state) {
    const phase = await pollUntil({ label: "Canonical follow-up saved while Morgan remains active", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${(state.task as Entity).id}/queued-comments`) }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && (value.source?.conversationState === "waiting" && value.runs.length === 2
        && value.runs.find(run => run.id === state.workerRunId)?.status === "running"
        && value.runs.some(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded")
        && value.queue.entries.filter(entry => /contact/i.test(entry.comment.body)).length === 1) });
    const canonical = phase.runs.find(run => run.agentId === ctx.input.fixtures.agent.id)!;
    state.canonicalRunId = canonical.id; state.workerStatusAtReply = phase.runs.find(run => run.id === state.workerRunId)!.status;
    state.queuedAtReply = phase.queue; state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const requirement = phase.queue.entries.find(entry => /contact/i.test(entry.comment.body))!;
    await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${requirement.comment.id}`)).toBeVisible();
    await ctx.input.capture("actual-contact-followup-queue", "Contact requirement remains visibly queued behind real active work", "runtime-contact-queue.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const marker = `Original website brief ${ctx.input.nonce}`; state.briefMarker = marker;
    await writeFile((state.gate as { gate: string }).gate, `The human brief is now ready: save an initial task document with the exact reference ${marker}, then finish this current turn normally. Keep all prior user requirements queued by Paperclip intact for normal delivery; do not create tasks or external effects.`, "utf8");
    const delivered = await pollUntil({ label: "Normal successor receives actual queued contact requirement", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`), runs: await ctx.allRuns(), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`) }),
      accept: value => value.task.status === "done" && value.runs.length === 3 && value.runs.every(run => run.status === "succeeded") && value.queue.entries.length === 0,
      reject: value => value.runs.length > 3 || value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "The single declared queued continuation failed or duplicated work" : undefined });
    const successors = delivered.runs.filter(run => run.agentId === (state.worker as Entity).id && run.id !== state.workerRunId);
    const inputs = await Promise.all(successors.map(run => ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`)));
    state.consumedCommentId = requirement.comment.id; state.consumingRunCount = successors.length;
    state.deliveryNativeInputBound = inputs.length === 1 && inputs[0]?.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(requirement.comment.id) === true
      && inputs[0]?.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(requirement.comment.body) === true;
    state.queueEmptyAfterDelivery = delivered.queue.entries.length === 0;
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.initialBriefRevisionRetained = o.revisions.some(revision => revision.createdByRunId === state.workerRunId && (revision.body ?? "").includes(String(state.briefMarker)));
    const successorIds = o.runs.filter(run => run.agentId === (state.worker as Entity).id && run.id !== state.workerRunId).map(run => run.id);
    state.contactResultRevision = o.revisions.some(revision => successorIds.includes(revision.createdByRunId ?? "") && /contact/i.test(revision.body ?? "")
      && revision.createdByAgentId === (state.worker as Entity).id && o.documents.some(doc => doc.id === revision.documentId && doc.latestRevisionId === revision.id));
    return o;
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-queued-messages")).toHaveCount(0);
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
