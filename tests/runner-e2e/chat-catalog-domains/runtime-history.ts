import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, runtimeWorker } from "./runtime-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { unavailableNativeModelFailure } from "./runtime-native-failure.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
type Artifact = Awaited<ReturnType<typeof readRegisteredArtifacts>>[number];

async function sourceSettled(ctx: ChatCatalogContext, count: number) {
  return pollUntil({ label: "Native persisted-history phase", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: value => chatCatalogNativePhaseIsTimely(ctx) && (value.source?.conversationState === "waiting" && value.runs.length === count
      && value.runs.filter(run => run.agentId === ctx.input.fixtures.agent.id).every(run => run.status === "succeeded")) });
}
async function retainHistory(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const rows = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
  state.historyRetained = (state.history as Entity[]).every(prior => rows.some(row => row.id === prior.id && row.body === prior.body && row.createdByRunId === prior.createdByRunId));
  const setup = state.setupRunIds as string[];
  const canonical = state.canonicalRunIds as string[] | undefined;
  const runs = await ctx.allRuns();
  const replies = rows.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id
    && runs.some(run => run.id === row.createdByRunId && (canonical ? canonical.includes(run.id) : !setup.includes(run.id))));
  state.queryReply = replies.map(row => row.body ?? "").join("\n");
  const links: string[] = [];
  for (const reply of replies) links.push(...await ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.id}`)}] a[href]`).evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!)));
  state.queryLinks = links;
}
async function attributedPhase(ctx: ChatCatalogContext, priorRunIds: string[], message: string) {
  const rows = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
  const human = rows.filter(row => !row.authorAgentId && row.body === message);
  const runs = (await ctx.allRuns()).filter(run => !priorRunIds.includes(run.id) && run.agentId === ctx.input.fixtures.agent.id);
  const replies = rows.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && runs.some(run => run.id === row.createdByRunId));
  const profiles = await Promise.all(runs.map(run => ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`)));
  const bound = human.length === 1 && profiles.some(run => run.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id));
  return { humanCommentId: human.length === 1 ? human[0]!.id : null, runIds: runs.map(run => run.id),
    reply: replies.map(row => row.body ?? "").join("\n"), attributed: bound && runs.length === 1 && replies.length > 0
      && replies.every(row => Date.parse(row.createdAt!) >= Date.parse(human[0]!.createdAt!)) };
}
/**
 * A clarification may end the turn as a reply or as a durable question card
 * the phase's own run created. Its effects are read by run attribution, not
 * by the model-chosen wording.
 */
async function clarificationPhase(ctx: ChatCatalogContext, priorRunIds: string[], message: string) {
  const base = await attributedPhase(ctx, priorRunIds, message); const sourceId = ctx.issue()!.id;
  const [rows, interactions, products, attachments, documents] = await Promise.all([
    ctx.input.api.get<Entity[]>(`/api/issues/${sourceId}/comments?order=asc`),
    ctx.input.api.get<Array<Entity & { kind?: string; status?: string; sourceRunId?: string | null }>>(`/api/issues/${sourceId}/interactions`),
    ctx.input.api.get<Array<{ id: string; createdByRunId?: string | null }>>(`/api/issues/${sourceId}/work-products`),
    ctx.input.api.get<Array<{ id: string; originatingRunId?: string | null }>>(`/api/issues/${sourceId}/attachments`),
    ctx.input.api.get<Entity[]>(`/api/issues/${sourceId}/documents`)]);
  const revisions = (await Promise.all(documents.map(doc => ctx.input.api.get<Array<{ id: string; createdByRunId?: string | null }>>(
    `/api/issues/${sourceId}/documents/${encodeURIComponent(doc.key!)}/revisions`)))).flat();
  const human = rows.find(row => row.id === base.humanCommentId);
  const questions = interactions.filter(row => row.kind === "ask_user_questions" && row.status === "pending"
    && !!row.sourceRunId && base.runIds.includes(row.sourceRunId) && !!human && Date.parse(row.createdAt!) >= Date.parse(human.createdAt!));
  const ownRun = (id?: string | null) => !!id && base.runIds.includes(id);
  const bound = base.attributed || (!!human && base.runIds.length === 1 && questions.length > 0
    && rows.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && ownRun(row.createdByRunId)).every(row => Date.parse(row.createdAt!) >= Date.parse(human.createdAt!)));
  return { ...base, answeredTurn: bound, questionIds: questions.map(row => row.id),
    createdArtifacts: [...products.filter(row => ownRun(row.createdByRunId)).map(row => row.id), ...attachments.filter(row => ownRun(row.originatingRunId)).map(row => row.id)],
    createdRevisions: revisions.filter(row => ownRun(row.createdByRunId)).map(row => row.id) };
}
async function linkedPreviews(ctx: ChatCatalogContext, links: string[]) {
  const sourceId = ctx.issue()!.id;
  const ids = [...new Set(links.map(href => { try { return new URL(href, ctx.input.api.baseURL).pathname.match(/^\/api\/attachments\/([^/]+)\/content$/)?.[1]; } catch { return undefined; } }).filter((id): id is string => !!id))];
  const attachments = await ctx.input.api.get<Array<{ id: string; issueId: string; originalFilename?: string | null; sha256: string; byteSize: number }>>(`/api/issues/${sourceId}/attachments`);
  return Promise.all(attachments.filter(row => ids.includes(row.id)).map(async row => {
    const bytes = await ctx.input.api.getAttachmentContent(row.id);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { attachmentId: row.id, issueId: row.issueId, originalFilename: row.originalFilename ?? null, sha256,
      contentVerified: bytes.length === row.byteSize && sha256 === row.sha256 };
  }));
}
type LinkedPreview = Awaited<ReturnType<typeof linkedPreviews>>[number];
/**
 * "That preview" is identified by its bytes: the canonical answer must link a
 * same-issue attachment whose downloaded content equals the selected preview.
 * Re-registering the identical file is acceptable; a regenerated or different
 * file is not. Reply wording is never graded.
 */
export function gradeRememberPreview(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-history-preview-evidence", !!o, "A genuine native preview, retained human selection and independently downloaded bytes are required."); if (!o) return c.result();
  const prior = o.state.previewBefore as Artifact; const after = o.state.previewAfter as Artifact;
  const linked = (o.state.linkedPreviews as LinkedPreview[] | undefined) ?? [];
  c.add("same-accessible-selected-preview", !!prior?.contentVerified && !!after?.contentVerified && prior.attachmentId === after.attachmentId
    && prior.sha256 === after.sha256 && after.content.includes(String(o.state.designMarker)) && /blue|#0000ff/i.test(after.content)
    && linked.some(row => row.contentVerified && row.sha256 === prior.sha256 && row.originalFilename === o.state.filename
      && (o.state.queryLinks as string[] | undefined)?.some(href => { try { const url = new URL(href, o.origin); return url.origin === o.origin && url.pathname === `/api/attachments/${row.attachmentId}/content`; } catch { return false; } }) === true),
  "The canonical answer links an accessible attachment whose downloaded bytes are exactly the selected blue preview, which itself remains intact.");
  c.add("persisted-choice-after-reload", o.state.reloaded === true && o.state.historyRetained === true && o.state.choiceEstablished === true
    && String(o.state.queryReply ?? "").trim().length > 0 && (o.state.canonicalRunIds as string[] | undefined)?.length === 1,
  "After reload, one canonical turn answers from genuinely retained history.");
  c.add("no-misrouted-followup", o.tasks.length === 0 && o.runs.every(run => run.status === "succeeded" && run.agentId === o.leadId),
  "No follow-up task or unrelated execution is introduced; neither request asked for one.");
  const unknown = o.state.unknownDesignPhase as { answeredTurn?: boolean; runIds?: string[]; createdArtifacts?: string[]; createdRevisions?: string[] } | undefined;
  c.add("unestablished-choice-clarified", unknown?.answeredTurn === true && unknown.runIds?.length === 1
    && unknown.createdArtifacts?.length === 0 && unknown.createdRevisions?.length === 0
    && o.tasks.length === 0 && o.runs.length === 3,
  "The never-selected alternate design gets its own turn that ends on a reply or pending question and creates no preview, document change or task.");
  return c.result();
}
export function gradeBrowserReconnect(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-disconnection-evidence", !!o, "Real browser offline state and independent server progress must be observed."); if (!o) return c.result();
  const task = o.state.task as Entity; const current = o.tasks.find(row => row.id === task.id);
  const workerRun = o.runs.find(run => run.id === o.state.workerRunId); const reply = String(o.state.queryReply ?? "");
  c.add("server-progressed-while-browser-offline", o.state.workerWasReallyWaiting === true && o.state.offlineObserved === true
    && o.state.workerStatusBeforeDisconnect === "running" && o.state.workerStatusWhileOffline === "succeeded"
    && o.state.taskStatusWhileOffline === "done" && o.state.serverAdvancedWhileOffline === true,
  "The actual existing worker completes on the server while the browser is disconnected.");
  c.add("reconnected-persisted-state", o.state.reconnected === true && o.state.historyRetained === true
    && o.state.offlineCommentsRetained === true && current?.status === "done" && workerRun?.status === "succeeded"
    && o.documents.some(doc => o.revisions.some(revision => revision.id === doc.latestRevisionId && revision.documentId === doc.id
      && revision.createdByRunId === workerRun.id && revision.createdByAgentId === (o.state.worker as Entity).id)),
  "Reloaded UI and public reads recover the persisted conversation, real task completion and delivered document.");
  c.add("honest-canonical-status", /done|complete|finished/i.test(reply) && !/still (?:working|running)|restart(?:ed|ing).*disconnect/i.test(reply)
    && (reply.includes(task.identifier ?? task.id) || /website/i.test(reply)),
  "The canonical reply reports actual completion rather than inferring a restart from reconnecting.");
  const remaining = o.state.remainingPhase as { attributed?: boolean; reply?: string; taskId?: string; runId?: string; offlineObserved?: boolean; runningWhileOffline?: boolean; reconnected?: boolean; runStatusAtReply?: string; taskStatusAtReply?: string } | undefined;
  const active = o.runs.find(run => run.id === remaining?.runId); const remainingTask = o.tasks.find(row => row.id === remaining?.taskId);
  c.add("remaining-work-reported-after-second-disconnect", remaining?.attributed === true && remaining.offlineObserved === true
    && remaining.runningWhileOffline === true && remaining.reconnected === true && !!active && !!remainingTask
    && remaining.runStatusAtReply === "running" && typeof remaining.taskStatusAtReply === "string" && remaining.taskStatusAtReply !== "done"
    && /running|working|waiting|not (?:yet )?(?:done|finished|complete)|still|in progress/i.test(remaining.reply ?? "")
    && !/(?:is|has|have) (?:now )?(?:finished|completed)|restarted.*disconnect/i.test(remaining.reply ?? ""),
  "Another genuine worker phase remains active through a second disconnect; only that phase's attributed answer reports the actual remaining work.");
  const failed = o.state.failedReconnectPhase as { attributed?: boolean; reply?: string; runId?: string; taskId?: string; offlineObserved?: boolean; failedWhileOffline?: boolean; reconnected?: boolean } | undefined;
  const failedRun = o.runs.find(run => run.id === failed?.runId);
  c.add("genuine-failed-run-not-promoted-to-success", failed?.attributed === true && failed.offlineObserved === true && failed.failedWhileOffline === true
    && failed.reconnected === true && failedRun?.runtimeMode === "native" && failedRun.status === "failed" && !!failedRun.errorCode
    && /fail|error|reject|could not|couldn't|did not finish/i.test(failed.reply ?? "")
    && !/(?:is|has) (?:now )?(?:finished|completed|succeeded)|restarted.*disconnect/i.test(failed.reply ?? ""),
  "A third genuine native failure occurs while offline; its own phase-attributed answer retains that failure instead of inferring success from missed events.");
  c.add("no-duplicate-send-or-worker", o.runs.length === 7 && o.runs.filter(run => run.agentId === (o.state.worker as Entity).id).length === 2
    && o.humanQueries.length === 4 && o.tasks.length === 3 && new Set(o.tasks.map(row => row.id)).size === 3
    && o.tasks.some(row => row.id === task.id) && !!remaining?.taskId && remaining.taskId !== task.id,
  "The three genuine worker tasks and four explicit source turns remain the only work; reconnecting neither replays sends nor restarts a worker.");
  return c.result();
}

export const runtimeHistoryCases = [runtimeDefinition("agent-chat.remember-and-follow-up", async ctx => {
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: ctx.input.fixtures.agent.id }])
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500,
      hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const source = await openStandingChat(ctx); const designMarker = `Selected blue preview ${ctx.input.nonce}`; const filename = `blue-preview-${ctx.input.nonce}.html`;
  await sendChatMessage(ctx.input.page, `We have selected the blue design. Save an actual small HTML preview named ${filename} with blue (#0000ff) styling and the exact visible marker ${JSON.stringify(designMarker)}. Register this real file as a downloadable artifact work product titled ${filename}. Keep that blue design and this exact preview as our selected version for the next turn. No delegated task or external action is needed.`, chatCatalogNativePhaseRemainingBudget(ctx));
  const phase = await sourceSettled(ctx, 1);
  const [previewBefore] = await readRegisteredArtifacts(ctx.input.api, source.id, phase.runs[0]!.id, [filename]);
  if (!previewBefore?.content.includes(designMarker) || !/blue|#0000ff/i.test(previewBefore.content)) throw new Error("Native prerequisite did not save the actual selected blue preview");
  const history = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  if (!history.some(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === phase.runs[0]!.id)) throw new Error("Prior agreement lacks actual native attribution");
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  return { designMarker, filename, previewBefore, history, initialRunId: phase.runs[0]!.id, setupRunIds: phase.runs.map(run => run.id), choiceEstablished: true, reloaded: true };
}, gradeRememberPreview, {
  sourceFiles: ["chat-catalog-domains/runtime-history.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agent-chat.yaml"],
  oracleVersion: "paperclip.chat-catalog.runtime.remember-preview.v3",
  setupHumanMessageCount: 1, expectedHumanMessageCount: 3, expectedRunCount: 3, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    const canonical = await sourceSettled(ctx, 2);
    state.canonicalRunIds = canonical.runs.filter(run => !(state.setupRunIds as string[]).includes(run.id)).map(run => run.id);
    await retainHistory(ctx, state);
    const prior = canonical.runs.map(run => run.id);
    const message = "Use the alternate green design I chose earlier, and show me that preview. If our history does not establish that alternate choice, ask me a focused clarification before creating or changing anything.";
    await sendChatMessage(ctx.input.page, message, chatCatalogNativePhaseRemainingBudget(ctx)); await sourceSettled(ctx, 3);
    state.unknownDesignPhase = await clarificationPhase(ctx, prior, message);
  },
  async observe(ctx, state) {
    await retainHistory(ctx, state);
    state.linkedPreviews = await linkedPreviews(ctx, state.queryLinks as string[]);
    [state.previewAfter] = await readRegisteredArtifacts(ctx.input.api, ctx.issue()!.id, String(state.initialRunId), [String(state.filename)]);
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value)!; const preview = state.previewAfter as Artifact;
    const same = (state.linkedPreviews as LinkedPreview[]).filter(row => row.contentVerified && row.sha256 === preview.sha256).map(row => row.attachmentId);
    const href = (state.queryLinks as string[]).find(link => { try { return same.some(id => new URL(link, o.origin).pathname === `/api/attachments/${id}/content`); } catch { return false; } });
    if (!href) throw new Error("The same persisted preview must be accessible from the rendered answer");
    const download = ctx.input.page.waitForEvent("download");
    await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).last().click();
    if ((await download).suggestedFilename() !== state.filename) throw new Error("Remembered preview UI downloaded a different file");
  },
}), runtimeDefinition("recovery.browser-reconnect", async ctx => {
  const state = await busyRuntimeWorker(ctx); const source = await openStandingChat(ctx);
  await sendChatMessage(ctx.input.page, `Please keep track of the existing Website task ${state.task.identifier ?? state.task.id}, assigned to Morgan. It is already running and waiting for the human brief. Acknowledge that reference without creating work or interrupting Morgan.`, chatCatalogNativePhaseRemainingBudget(ctx));
  await sourceSettled(ctx, 2);
  const history = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  const before = await ctx.allRuns(); const original = before.find(run => run.id === state.workerRunId);
  if (original?.status !== "running") throw new Error("Reconnect fixture requires genuinely active server work");
  await ctx.input.page.context().setOffline(true);
  try {
    const offlineObserved = await ctx.input.page.evaluate(() => navigator.onLine === false);
    if (!offlineObserved) throw new Error("Browser did not actually disconnect");
    await writeFile(state.gate.gate, `The real human brief is now available: save a website delivery task document with the marker Reconnected website ${ctx.input.nonce}. Complete this original task normally.`, "utf8");
    const advanced = await pollUntil({ label: "Server completes while browser is offline", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${state.task.id}`), runs: await ctx.allRuns(),
        comments: await ctx.input.api.get<Entity[]>(`/api/issues/${state.task.id}/comments?order=asc`) }),
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && (value.task.status === "done" && value.runs.find(run => run.id === state.workerRunId)?.status === "succeeded"),
      reject: value => value.runs.some(run => run.id === state.workerRunId && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Disconnected worker did not complete successfully" : undefined });
    if (!advanced.comments.some(row => row.createdByRunId === state.workerRunId && row.authorAgentId === state.worker.id)) throw new Error("Offline progress lacks real persisted worker comments");
    return { ...state, history, offlineComments: advanced.comments, setupRunIds: advanced.runs.map(run => run.id), offlineObserved,
      workerStatusBeforeDisconnect: original.status, workerStatusWhileOffline: advanced.runs.find(run => run.id === state.workerRunId)!.status, taskStatusWhileOffline: advanced.task.status,
      serverAdvancedWhileOffline: true };
  } finally {
    await ctx.input.page.context().setOffline(false);
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  }
}, gradeBrowserReconnect, {
  sourceFiles: ["chat-catalog-domains/runtime-history.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-native-failure.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/recovery.yaml"],
  setupHumanMessageCount: 1, expectedHumanMessageCount: 4, expectedRunCount: 7, attemptTimeoutMs: 1_200_000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 6, failed: 1 } },
  async act(ctx, state) {
    const canonical = await sourceSettled(ctx, 3);
    state.canonicalRunIds = canonical.runs.filter(run => !(state.setupRunIds as string[]).includes(run.id)).map(run => run.id);
    await retainHistory(ctx, state);
    const next = await busyRuntimeWorker(ctx, { worker: state.worker as Awaited<ReturnType<typeof busyRuntimeWorker>>["worker"] });
    state.remainingFixture = next;
    await ctx.input.page.context().setOffline(true);
    let offlineObserved = false, runningWhileOffline = false;
    try {
      offlineObserved = await ctx.input.page.evaluate(() => navigator.onLine === false);
      const actual = (await ctx.allRuns()).find(run => run.id === next.workerRunId);
      runningWhileOffline = actual?.status === "running";
    } finally {
      await ctx.input.page.context().setOffline(false);
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    }
    const prior = (await ctx.allRuns()).map(run => run.id);
    const message = `I was disconnected again while Morgan worked on the new Website task ${next.task.identifier ?? next.task.id}. Is that follow-up website finished? Please report its actual current state; do not start another task or interrupt it.`;
    await sendChatMessage(ctx.input.page, message, chatCatalogNativePhaseRemainingBudget(ctx)); await sourceSettled(ctx, 5);
    const remainingRun = (await ctx.allRuns()).find(run => run.id === next.workerRunId);
    const remainingTask = await ctx.input.api.get<Entity>(`/api/issues/${next.task.id}`);
    state.remainingPhase = { ...await attributedPhase(ctx, prior, message), taskId: next.task.id, runId: next.workerRunId,
      offlineObserved, runningWhileOffline, reconnected: await ctx.input.page.evaluate(() => navigator.onLine),
      runStatusAtReply: remainingRun?.status, taskStatusAtReply: remainingTask.status };
    await releaseRuntimeWorker(next);
    await pollUntil({ label: "Remaining phase settles before separate failed-native phase", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: () => ctx.allRuns(), accept: rows => chatCatalogNativePhaseIsTimely(ctx) && (rows.length === 5 && rows.every(run => run.status === "succeeded")) });
    const failureWorker = await runtimeWorker(ctx, "Riley"); let failedTask: Entity | undefined;
    let failedOffline = false, failure: Awaited<ReturnType<typeof unavailableNativeModelFailure>> | undefined;
    await ctx.input.page.context().setOffline(true);
    try {
      failedOffline = await ctx.input.page.evaluate(() => navigator.onLine === false);
      failure = await unavailableNativeModelFailure(ctx, failureWorker, async () => {
        failedTask = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, {
          title: "Website configuration-failure attempt", status: "todo", assigneeAgentId: failureWorker.id,
          description: "Draft a single-page website and save a task document. Do not create another task or external side effect." });
        return { issueId: failedTask.id };
      });
    } finally {
      await ctx.input.page.context().setOffline(false);
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    }
    if (!failure || !failedTask) throw new Error("The offline fixture produced no genuine native failure");
    const failureBoundary = (await ctx.allRuns()).map(run => run.id);
    const failedMessage = `I was disconnected during Riley's Website configuration-failure attempt ${failedTask!.identifier ?? failedTask!.id}. Did that attempt finish? Read its actual retained run state and explain it without starting another attempt.`;
    await sendChatMessage(ctx.input.page, failedMessage, chatCatalogNativePhaseRemainingBudget(ctx)); await sourceSettled(ctx, 7);
    state.failedReconnectEvidence = failure;
    state.failedReconnectPhase = { ...await attributedPhase(ctx, failureBoundary, failedMessage), runId: failure.failedRun.id, taskId: failedTask!.id,
      offlineObserved: failedOffline, failedWhileOffline: failure.failedRun.status === "failed", reconnected: await ctx.input.page.evaluate(() => navigator.onLine) };
  },
  async observe(ctx, state) {
    state.reconnected = await ctx.input.page.evaluate(() => navigator.onLine);
    await retainHistory(ctx, state); const o = await observeRuntime(ctx, state);
    state.offlineCommentsRetained = (state.offlineComments as Entity[]).every(prior => o.comments.some(row => row.id === prior.id && row.body === prior.body && row.createdByRunId === prior.createdByRunId));
    return o;
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    await ctx.input.evidence("runtime-reconnected-work-ui.json", { taskId: task.id, originalRunId: state.workerRunId, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  cleanup: async (_ctx, state) => { await releaseRuntimeWorker(state); if (state.remainingFixture) await releaseRuntimeWorker(state.remainingFixture as Record<string, unknown>); },
})];
