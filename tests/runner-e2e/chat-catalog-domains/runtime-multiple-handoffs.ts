import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { IssueQueuedCommentQueue } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { handledInTurn, promptCarriesComment, readCurrentRevision, replyNamesTask, runCommentReceipts, runtimeQueueCases, settledQueue, wakeMarksEarlierRead } from "./runtime-queue.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, runtimeWorker } from "./runtime-support.js";
export { promptCarriesComment } from "./runtime-queue.js";
type Artifact = Awaited<ReturnType<typeof readRegisteredArtifacts>>[number];
export function gradeMultipleHandoffs(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-two-task-history-and-delivery-evidence", !!o, "Separate real website/logo work, saved source references and exact consuming native input are required."); if (!o) return c.result();
  const s = o.state, queue = s.queueAtReply as IssueQueuedCommentQueue, target = queue?.entries[0], logoBefore = s.logoBefore as Entity, logo = s.logoAfter as Entity;
  const before = s.logoArtifactBefore as Artifact, after = s.logoArtifactAfter as Artifact;
  const worker = s.worker as Entity | undefined, websiteRuns = o.runs.filter(row => row.agentId === worker?.id);
  const continuations = websiteRuns.filter(row => row.id !== s.workerRunId), saved = s.savedComment as { id: string; updatedAt?: unknown } | undefined;
  const receipts = s.workerCommentReceipts as { reads?: Record<string, string>; cited?: string[] } | undefined;
  const isTarget = !!saved && saved.id === target?.comment.id;
  const readInTurn = isTarget && readCurrentRevision(receipts?.reads, saved), handled = isTarget && handledInTurn(receipts, saved);
  const consumedInTurn = handled && continuations.length === 0 && s.inTurnHeadlineRevision === true;
  const consumedByContinuation = !handled && continuations.length === 1 && s.nativeDeliveryBound === true && s.finalHeadlineRevision === true
    && s.originalWebsiteRevisionRetained === true && (!readInTurn || s.continuationWarnedEarlierRead === true);
  c.add("existing-website-worker-receives-one-saved-requirement", s.sourceHistoryBound === true && queue?.issueId === (s.task as Entity).id
    && queue.targetRunId === s.workerRunId && queue.entries.length === 1 && ["queued", "deferred"].includes(queue.state ?? "")
    && target?.comment.authorAgentId === o.leadId && target.comment.createdByRunId === s.canonicalRunId && target.comment.body.includes("Launch sooner")
    && s.workerRunningAtReply === true && (consumedInTurn || consumedByContinuation) && s.queueEmptyAfterDelivery === true,
  "One CEO-attributed headline instruction is saved against the actual active Website owner and is consumed once: read at its current revision, applied and cited as handled by the running turn with no continuation, or delivered to exactly one ordinary continuation, which is told when the running turn already read it.");
  c.add("logo-task-and-delivered-logo-unchanged", !!logoBefore && !!logo && sameTask(logoBefore, logo) && logo.status === "done" && logo.assigneeAgentId === (s.logoWorker as Entity).id
    && before?.contentVerified === true && after?.contentVerified === true && before.attachmentId === after.attachmentId && before.sha256 === after.sha256
    && before.content === after.content && after.content.includes(String(s.logoMarker)) && /<svg\b/i.test(after.content) && s.logoRevisionsUnchanged === true,
  "The separate real Logo task, logo bytes, artifact identity, saved revisions and original worker attribution remain unchanged.");
  // The reply's account of pending versus applied work is free-form; it is read from the evidence, not matched by wording.
  c.add("canonical-reply-identifies-affected-task", replyNamesTask(String(s.queryReply), s.task as Entity),
  "The canonical reply, written while the saved instruction still waits behind active work, names the affected Website task.");
  c.add("real-final-headline-and-original-work-retained", (consumedInTurn || consumedByContinuation)
    && o.tasks.length === 2 && o.tasks.some(row => row.id === (s.task as Entity).id && row.status === "done" && row.assigneeAgentId === worker?.id)
    && o.runs.length === 3 + websiteRuns.length && o.runs.every(row => row.status === "succeeded")
    && o.runs.filter(row => row.agentId === (s.logoWorker as Entity).id).length === 1,
  "The final actual Website revision contains the requested headline, preserves prior work, and no duplicate task, logo run or wrong-worker execution is introduced.");
  return c.result();
}
export const runtimeMultipleHandoffCases = [runtimeDefinition("agent-chat.multiple-handoffs", async ctx => {
  const logoWorker = await runtimeWorker(ctx, "Riley"), root = `/api/companies/${ctx.input.fixtures.company.id}`, logoMarker = `Acorn logo ${ctx.input.nonce}`;
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: logoWorker.id }])
    await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const logo = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Logo", status: "todo", assigneeAgentId: logoWorker.id,
    description: `Create an actual small logo file logo.html containing an inline SVG with a simple acorn/circle mark, visible text Acorn and the exact reference ${logoMarker} in its SVG metadata or text. Save a short non-plan task delivery document describing it and register the real logo.html file as a downloadable artifact work product titled logo.html. Then complete this same task. No other task, publication or website change is authorized.` });
  const complete = await pollUntil({ label: "Actual separate Logo work completed before the Website conversation", deadlineAt: Date.now() + 240_000,
    load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${logo.id}`), runs: await ctx.allRuns() }),
    accept: v => v.task.status === "done" && v.runs.length === 1 && v.runs[0]?.agentId === logoWorker.id && v.runs[0].status === "succeeded" });
  const [artifact] = await readRegisteredArtifacts(ctx.input.api, logo.id, complete.runs[0]!.id, ["logo.html"]);
  if (!artifact?.contentVerified || !artifact.content.includes(logoMarker) || !/<svg\b/i.test(artifact.content)) throw new Error("Completed Logo prerequisite lacks its actual native-created logo");
  const documents = await ctx.input.api.get<Entity[]>(`/api/issues/${logo.id}/documents`), revisions: Entity[] = [];
  for (const doc of documents) revisions.push(...await ctx.input.api.get<Entity[]>(`/api/issues/${logo.id}/documents/${encodeURIComponent(doc.key!)}/revisions`));
  const busy = await busyRuntimeWorker(ctx); await openStandingChat(ctx);
  const message = `Keep these two existing work references in this conversation: Website ${busy.task.identifier ?? busy.task.id} is assigned to Morgan, who is working on it now; Logo ${logo.identifier ?? logo.id} was completed by Riley and its actual delivered logo is [logo.html](${new URL(`/api/attachments/${artifact.attachmentId}/content?download=1`, ctx.input.api.baseURL).href}). Acknowledge these separate references, without creating, reassigning, editing or starting any task. Keep the Logo deliverable unchanged.`;
  await sendChatMessage(ctx.input.page, message);
  const saved = await pollUntil({ label: "Real source history retains separate active Website and completed Logo", deadlineAt: Date.now() + 150_000,
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: v => v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.some(row => row.id === busy.workerRunId && row.status === "running")
      && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") });
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
  return { ...busy, logoWorker, logoBefore: complete.task, logoRunId: complete.runs[0]!.id, logoMarker, logoArtifactBefore: artifact, logoDocumentsBefore: documents, logoRevisionsBefore: revisions,
    // The composer may normalize Markdown, so bind the one human setup message by its setup-chosen references.
    sourceHistoryBound: comments.filter(row => !row.authorAgentId).length === 1 && comments.some(row => !row.authorAgentId
      && row.body?.includes(busy.task.identifier ?? busy.task.id) && row.body.includes(logo.identifier ?? logo.id) && row.body.includes(artifact.attachmentId)), setupRunIds: saved.runs.map(row => row.id) };
}, gradeMultipleHandoffs, {
  setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 5, minimumRunCount: 4, attemptTimeoutMs: 1_020_000, oracleVersion: "paperclip.chat-catalog.runtime-multiple-handoffs.v6",
  sourceFiles: ["chat-catalog-domains/runtime-multiple-handoffs.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "registered-artifact.ts", "chat-scenarios/agent-chat.yaml"],
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  async act(ctx, state) {
    const task = state.task as Entity, queuePath = `/api/issues/${task.id}/queued-comments`;
    const first = await pollUntil({ label: "Headline feedback saved on existing active Website", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(queuePath) }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 4 && v.queue.entries.length === 1
        && v.runs.some(row => row.id === state.workerRunId && row.status === "running") && v.runs.filter(row => row.agentId === ctx.input.fixtures.agent.id).every(row => row.status === "succeeded") });
    state.canonicalRunId = first.runs.find(row => !(state.setupRunIds as string[]).includes(row.id))!.id;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    state.queryReply = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === state.canonicalRunId).map(row => row.body).join("\n");
    state.queueAtReply = first.queue; state.workerRunningAtReply = true;
    await writeFile((state.gate as { gate: string }).gate, "The original human brief is now ready. Save the current website plan as a task document with headline Launch later and accessible labels, then finish this current turn normally.", "utf8");
    const consumedInTurn = settledQueue((v: { runs: Array<{ status: string }>; task: Entity; queue: IssueQueuedCommentQueue }) => v.runs.length === 4
      && v.runs.every(row => row.status === "succeeded") && v.task.status === "done" && v.queue.entries.length === 0, 30_000);
    const final = await pollUntil({ label: "The saved headline feedback is consumed once, in the running turn or one ordinary continuation", deadlineAt: Date.now() + 300_000,
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(queuePath) }),
      accept: v => consumedInTurn(v) || v.runs.length === 5 && v.runs.every(row => row.status === "succeeded") && v.task.status === "done" && v.queue.entries.length === 0,
      reject: v => v.runs.length > 5 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Headline continuation failed or duplicated/wrong-task work" : undefined });
    const saved = first.queue.entries[0]!.comment, current = (await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/comments?order=asc`)).find(row => row.id === saved.id);
    state.savedComment = current ? { id: current.id, updatedAt: current.updatedAt } : null;
    state.workerCommentReceipts = await runCommentReceipts(ctx, String(state.workerRunId));
    const consumer = final.runs.find(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId);
    const detail = consumer && await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[]; paperclipWake?: { comments?: Array<{ id?: string; readByEarlierTurn?: boolean }> } }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${consumer.id}`);
    state.continuationWarnedEarlierRead = wakeMarksEarlierRead(detail?.contextSnapshot, saved.id);
    state.nativeDeliveryBound = detail?.contextSnapshot?.wakeCommentIds?.length === 1 && detail.contextSnapshot.wakeCommentIds[0] === saved.id
      && promptCarriesComment(detail.runnerProfileJson?.nativeExecutionInput?.task?.prompt, saved);
    state.queueEmptyAfterDelivery = final.queue.entries.length === 0; state.finalWebsiteRunId = consumer?.id ?? null;
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state), logo = state.logoBefore as Entity;
    state.logoAfter = await ctx.input.api.get<Entity>(`/api/issues/${logo.id}`);
    const [artifact] = await readRegisteredArtifacts(ctx.input.api, logo.id, String(state.logoRunId), ["logo.html"]); state.logoArtifactAfter = artifact;
    const documents = await ctx.input.api.get<Entity[]>(`/api/issues/${logo.id}/documents`), revisions: Entity[] = [];
    for (const doc of documents) revisions.push(...await ctx.input.api.get<Entity[]>(`/api/issues/${logo.id}/documents/${encodeURIComponent(doc.key!)}/revisions`));
    state.logoRevisionsUnchanged = JSON.stringify(documents.map(doc => [doc.id, doc.latestRevisionId]).sort()) === JSON.stringify((state.logoDocumentsBefore as Entity[]).map(doc => [doc.id, doc.latestRevisionId]).sort())
      && revisions.length === (state.logoRevisionsBefore as Entity[]).length && (state.logoRevisionsBefore as Entity[]).every(prior => revisions.some(row => row.id === prior.id && row.body === prior.body && row.createdByRunId === prior.createdByRunId));
    state.originalWebsiteRevisionRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && /Launch later/.test(row.body ?? ""));
    const latestHeadline = (runId: unknown) => !!runId && o.revisions.some(row => row.createdByRunId === runId && row.createdByAgentId === (state.worker as Entity).id && /Launch sooner/.test(row.body ?? "")
      && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
    state.finalHeadlineRevision = latestHeadline(state.finalWebsiteRunId); state.inTurnHeadlineRevision = latestHeadline(state.workerRunId); return o;
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url();
    for (const task of [state.task as Entity, state.logoBefore as Entity]) {
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    }
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
