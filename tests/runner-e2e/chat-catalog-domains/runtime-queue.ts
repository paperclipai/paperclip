import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { pollUntil } from "../api.js";
import { checks, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
import type { IssueAttachment, IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";
const MAX_DELIVERABLE_BYTES = 262_144;
/** Text of each stored or deflated entry in a zip deliverable, read from its central directory; [] when it is not a readable zip. */
export function zipEntryTexts(bytes: Buffer): string[] {
  try {
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0 || eocd + 22 > bytes.length) return [];
    const texts: string[] = []; let at = bytes.readUInt32LE(eocd + 16);
    for (let index = 0, count = bytes.readUInt16LE(eocd + 10); index < count && at + 46 <= bytes.length && bytes.readUInt32LE(at) === 0x02014b50; index++) {
      const method = bytes.readUInt16LE(at + 10), size = bytes.readUInt32LE(at + 20), local = bytes.readUInt32LE(at + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), data = bytes.subarray(start, start + size);
      if (method === 0) texts.push(data.toString("utf8"));
      else if (method === 8) texts.push(inflateRawSync(data, { maxOutputLength: 4 * MAX_DELIVERABLE_BYTES }).toString("utf8"));
      at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    return texts;
  } catch { return []; }
}
/** Find a message object with the exact comment id and body, descending into JSON nested as string values. */
function jsonCarriesComment(value: unknown, comment: { id: string; body: string }, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") {
    const text = value.trim(); if (!/^[[{]/.test(text)) return false;
    try { return jsonCarriesComment(JSON.parse(text), comment, depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => jsonCarriesComment(item, comment, depth + 1));
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.id === comment.id && row.body === comment.body) || Object.values(row).some(item => jsonCarriesComment(item, comment, depth + 1));
}
/** Native continuations embed new comments as JSON (an envelope may nest it again as a string), so a body with quotes or newlines appears escaped. */
export function promptCarriesComment(prompt: string | undefined, comment: { id: string; body: string }) {
  return typeof prompt === "string" && prompt.includes(comment.id)
    && (prompt.includes(comment.body) || prompt.includes(JSON.stringify(comment.body).slice(1, -1)) || jsonCarriesComment(prompt, comment));
}
/** A task is named by its setup-assigned identifier (which chat links) or by a link to its page. */
export function replyNamesTask(reply: string, task: Entity) {
  const keys = [task.identifier, task.id].filter((key): key is string => !!key);
  return keys.some(key => new RegExp(`(?<![A-Za-z0-9-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(reply));
}
/** The saved requirement is the one queued comment the controller's canonical turn wrote; its wording is the model's. */
function savedRequirement(queue: IssueQueuedCommentQueue | undefined, leadId: string) {
  return queue?.entries.length === 1 && queue.entries[0]!.comment.authorAgentId === leadId ? queue.entries[0] : undefined;
}
export function gradeQueuedFollowup(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-queue-and-delivery-evidence", !!o, "The actual task queue, saved requirement, real initial worker and later consuming native input are required."); if (!o) return c.result();
  const task = o.state.task as Entity; const queued = o.state.queuedAtReply as IssueQueuedCommentQueue | undefined;
  const requirement = savedRequirement(queued, o.leadId);
  c.add("correct-task-ordered-waiting-requirement-once", !!queued && queued.issueId === task.id && ["queued", "deferred"].includes(queued.state ?? "")
    && queued.entries.length === 1 && requirement?.position === 0 && o.state.workerStatusAtReply === "running"
    && requirement.comment.createdByRunId === o.state.canonicalRunId,
  "Exactly one contact-section instruction is durably queued in order on the genuine running Website task and attributed to the source controller turn.");
  // Whether the reply describes the requirement as pending is free-form; it is read from the evidence, not matched by wording.
  c.add("canonical-reply-identifies-affected-task", replyNamesTask(String(o.state.queryReply), task),
  "The canonical reply, written while the requirement still waits behind Morgan's active turn, names the Website task it was saved on.");
  c.add("normal-continuation-consumes-exact-input-once", !!requirement && o.state.consumedCommentId === requirement.comment.id
    && o.state.deliveryNativeInputBound === true && o.state.consumingRunCount === 1 && o.state.queueEmptyAfterDelivery === true
    && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded")
    && o.runs.filter(run => run.agentId === (o.state.worker as Entity).id).length === 2,
  "The same saved requirement is consumed by one ordinary successor native turn after the real prior owner settles.");
  c.add("earlier-work-and-contact-result-retained", o.state.initialBriefRevisionRetained === true && (o.state.contactResultRevision === true || o.state.contactResultDeliverable === true)
    && o.tasks.length === 1 && o.tasks[0]?.id === task.id && o.tasks[0]?.assigneeAgentId === (o.state.worker as Entity).id && o.tasks[0]?.status === "done",
  "The original worker's saved brief revision remains inspectable and the successor saves an actual contact-section result on the same task, as a document revision or a registered deliverable.");
  return c.result();
}
export const runtimeQueueCases = [runtimeDefinition("steering.queue-follow-up", busyRuntimeWorker, gradeQueuedFollowup, {
  oracleVersion: "paperclip.chat-catalog.runtime-queue.v3",
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
        && !!savedRequirement(value.queue, ctx.input.fixtures.agent.id)) });
    const canonical = phase.runs.find(run => run.agentId === ctx.input.fixtures.agent.id)!;
    state.canonicalRunId = canonical.id; state.workerStatusAtReply = phase.runs.find(run => run.id === state.workerRunId)!.status;
    state.queuedAtReply = phase.queue; state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const requirement = savedRequirement(phase.queue, ctx.input.fixtures.agent.id)!;
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
    state.deliveryNativeInputBound = inputs.length === 1 && promptCarriesComment(inputs[0]?.runnerProfileJson?.nativeExecutionInput?.task?.prompt, requirement.comment);
    state.queueEmptyAfterDelivery = delivered.queue.entries.length === 0;
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.initialBriefRevisionRetained = o.revisions.some(revision => revision.createdByRunId === state.workerRunId && (revision.body ?? "").includes(String(state.briefMarker)));
    const successorIds = o.runs.filter(run => run.agentId === (state.worker as Entity).id && run.id !== state.workerRunId).map(run => run.id);
    state.contactResultRevision = o.revisions.some(revision => successorIds.includes(revision.createdByRunId ?? "") && /contact/i.test(revision.body ?? "")
      && revision.createdByAgentId === (state.worker as Entity).id && o.documents.some(doc => doc.id === revision.documentId && doc.latestRevisionId === revision.id));
    // A website build may be delivered as a registered file (often a zip) rather than a document; its file name is the model's, so read every successor deliverable's verified bytes.
    const taskId = (state.task as Entity).id;
    const [products, attachments] = await Promise.all([ctx.input.api.get<IssueWorkProduct[]>(`/api/issues/${taskId}/work-products`), ctx.input.api.get<IssueAttachment[]>(`/api/issues/${taskId}/attachments`)]);
    const delivered = attachments.filter(attachment => attachment.issueId === taskId && successorIds.includes(attachment.originatingRunId ?? "") && attachment.byteSize <= MAX_DELIVERABLE_BYTES
      && products.some(product => product.type === "artifact" && product.createdByRunId === attachment.originatingRunId && product.metadata?.attachmentId === attachment.id));
    const texts: string[] = [];
    for (const attachment of delivered) {
      const bytes = await ctx.input.api.getAttachmentContent(attachment.id);
      if (bytes.length !== attachment.byteSize || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) continue;
      const entries = zipEntryTexts(bytes); texts.push(...(entries.length > 0 ? entries : [bytes.toString("utf8")]));
    }
    state.contactResultDeliverable = texts.some(text => /contact/i.test(text));
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
