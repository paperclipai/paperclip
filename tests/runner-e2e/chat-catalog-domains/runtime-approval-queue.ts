import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { ActivityEvent } from "../../../packages/shared/src/types/activity.js";
import type { IssueQueuedCommentQueue, IssueThreadInteraction } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { checks, type Entity } from "./internal-support.js";
import { prepareRuntimeWorkerGate, readRuntimeTaskGate, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeQueueCases } from "./runtime-queue.js";
import { runtimeDefinition, observeRuntime, runtimeObservation } from "./runtime-support.js";
type PendingInputRun = { id?: string; status?: string; resultJson?: { nativeResult?: { reportedWorkDisposition?: string; continuation?: { kind?: string; idempotencyKey?: string };
  evidence?: Array<{ ref?: string }>; artifacts?: Array<{ ref?: string }> } } | null };
/**
 * A native worker that saves a durable wake-based question parks its turn: the run
 * succeeds with a yielded disposition whose continuation is the question's response
 * wake. That saved yield, not a still-running process, is the product's pending-input state.
 */
export function pendingInputYield(run: PendingInputRun | null | undefined, questionId: string) {
  const result = run?.resultJson?.nativeResult, ref = `interaction:${questionId}`;
  return run?.status === "succeeded" && result?.reportedWorkDisposition === "yielded" && result.continuation?.kind === "response_wake"
    && result.continuation.idempotencyKey === `interaction-response:${questionId}` && [...(result.evidence ?? []), ...(result.artifacts ?? [])].some(row => row.ref === ref);
}
export function ordinaryApprovalEntries(queue: Pick<IssueQueuedCommentQueue, "entries">, humanId?: string) {
  return queue.entries.filter(row => !row.source && (humanId === undefined || (row.comment.authorUserId === humanId && !row.comment.authorAgentId)));
}
/** Entries the chat lead queued itself, such as a relayed copy of the person's answer. They are not the person's messages. */
export function leadRelayEntries(queue: Pick<IssueQueuedCommentQueue, "entries">, leadId: string) {
  return queue.entries.filter(row => !row.source && row.comment.authorAgentId === leadId);
}
/**
 * The composer lists one pending wake at a time and prefers editable ordinary messages over a saved card response
 * (#19331): a receipt must never hide someone's later messages. So while the chat lead's own relay comment waits, the
 * queue shows that relay and the bound answer keeps its own, unlisted wake. Either listing is a valid view of the
 * same saved answer; what the person relies on is that the answer is retained and later delivered exactly once.
 */
export function approvalResponseListing(queue: Pick<IssueQueuedCommentQueue, "entries">, questionId: string, leadId: string) {
  const bound = queue.entries.filter(row => row.source);
  if (bound.length === 1 && queue.entries.length === 1 && bound[0]!.source?.kind === "interaction" && bound[0]!.source.interactionId === questionId
    && bound[0]!.canEdit === false && bound[0]!.canDiscard === false) return "listed" as const;
  if (bound.length === 0 && queue.entries.length > 0 && queue.entries.length === leadRelayEntries(queue, leadId).length) return "behind_lead_relay" as const;
  return null;
}
type SuccessorRun = { id: string; contextSnapshot?: { interactionId?: unknown; wakeCommentIds?: unknown } | null };
/** Worker turns after the original owner: the one bound to the answer, turns that only carry the lead's relay, and anything else. */
export function classifyApprovalSuccessors(runs: SuccessorRun[], questionId: string, leadCommentIds: ReadonlySet<string>) {
  const bound: string[] = [], relay: string[] = [], other: string[] = [];
  for (const run of runs) {
    const context = run.contextSnapshot ?? {}, comments = Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds.map(String) : [];
    if (context.interactionId === questionId) bound.push(run.id);
    else if (!context.interactionId && comments.length > 0 && comments.every(id => leadCommentIds.has(id))) relay.push(run.id);
    else other.push(run.id);
  }
  return { bound, relay, other };
}
type SavedRevision = { id?: unknown; documentId?: unknown; createdByRunId?: unknown; createdByAgentId?: unknown; createdAt?: unknown; body?: unknown };
/**
 * Where the current Acorn document came from. A later worker turn (the one bound to the answer, or the lead's relay
 * turn) counts. So does the worker's settling turn, but only for a revision it saved after the answer was saved: an
 * agent may read the answered question on its own task, and the answer still reaches exactly one bound turn later.
 * A revision saved before the answer existed, by another agent, or no longer current does not count.
 */
export function acornWorkSource(input: { revisions: SavedRevision[]; documents: Array<{ id?: unknown; latestRevisionId?: unknown }>; workerId: string;
  successorRunIds: string[]; settlingRunId: string; answeredAt: unknown }) {
  const answered = typeof input.answeredAt === "string" ? Date.parse(input.answeredAt) : NaN;
  const current = input.revisions.filter(row => row.createdByAgentId === input.workerId && typeof row.body === "string" && /\bAcorn\b/.test(row.body)
    && input.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
  if (current.some(row => typeof row.createdByRunId === "string" && input.successorRunIds.includes(row.createdByRunId))) return "delivered_turn" as const;
  if (Number.isFinite(answered) && current.some(row => row.createdByRunId === input.settlingRunId && typeof row.createdAt === "string" && Date.parse(row.createdAt) > answered))
    return "settling_turn_after_answer" as const;
  return null;
}
export function gradeApprovalQueue(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-question-response-and-ordinary-queue-evidence", !!o, "The actual native question, human response, separate queue mutations and once-only consuming native input are required."); if (!o) return c.result();
  const s = o.state, question = s.questionBefore as IssueThreadInteraction, answered = s.questionAfter as IssueThreadInteraction;
  c.add("genuine-prior-worker-question-and-saved-comments", !!question && question.kind === "ask_user_questions" && question.status === "pending" && question.issueId === (s.task as Entity).id
    && question.createdByAgentId === (s.worker as Entity).id && question.sourceRunId === s.questionRunId && s.questionRunYielded === true
    && typeof s.workerRunId === "string" && s.workerRunId !== s.questionRunId && s.workerWasReallyWaiting === true
    && s.ordinaryQueueOwned === true && s.ordinaryQueuedBeforeAnswer === true,
  "Morgan's actual native turn saves the naming question and parks on it; a later real Morgan turn is still active while the human's separate ordinary comments wait.");
  const results = answered?.result as { answers?: Array<{ questionId?: string; otherText?: string }> } | null;
  c.add("actual-bound-human-answer-preserved", answered?.id === question.id && answered.status === "answered" && ((answered.resolvedByUserId === s.humanId && !answered.resolvedByAgentId && s.humanAnswerSubmitted === true) || (answered.resolvedByAgentId === o.leadId && s.canonicalAnswerAttributed === true))
    && JSON.stringify(answered.payload) === JSON.stringify(question.payload) && results?.answers?.some(row => row.questionId === "name" && row.otherText === "Acorn") === true
    && s.responseRetainedAcrossOrdinaryMutations === true && s.responseUneditable === true,
  "Acorn remains the same immutable typed interaction response, distinct from the editable/deletable ordinary comment queue.");
  c.add("bound-answer-path-and-real-ordinary-mutations", (s.humanAnswerSubmitted === true) !== (s.canonicalAnswerAttributed === true)
    && s.actualOrdinaryEdit === true && (s.actualOrdinaryReorder === true || s.ordinaryReorderRestricted === true) && s.actualOrdinaryDiscard === true,
  "Exactly one actual path records Acorn on the bound question (the human's response control, or an attributed canonical response); editing, ordering and discarding ordinary messages cannot impersonate or cancel it.");
  const response = s.responseQueue as IssueQueuedCommentQueue, listing = response ? approvalResponseListing(response, question.id, o.leadId) : null;
  c.add("response-kept-apart-from-ordinary-queue", !!listing && listing === s.responseListing && (listing === "listed" ? s.responseListedImmutable === true : true),
    "Once the person's messages are gone the queue holds either the uneditable, undiscardable Acorn response alone, or only the chat lead's own relay ahead of it; never a person's message or an editable copy of the answer.");
  const relayRuns = Number(s.relayRunCount);
  c.add("response-own-delivery-semantics-and-once-only-admission", s.consumingRunCount === 1 && s.unexpectedSuccessorRunCount === 0 && Number.isInteger(relayRuns) && relayRuns >= 0 && relayRuns <= 1
    && s.responseNativeInputBound === true && s.queueEmptyAfterDelivery === true
    && o.runs.length === 4 + relayRuns && o.runs.every(row => row.status === "succeeded") && o.tasks.length === 1 && s.actualAcornResult === true && s.initialWorkRetained === true,
  "After the original owner settles, exactly one native continuation is bound to the answer and receives it; the only other worker turn allowed carries just the lead's relay; Acorn work is saved and earlier work kept.");
  return c.result();
}
export const runtimeApprovalQueueCases = [runtimeDefinition("steering.approval-delivery", async ctx => {
  const prepared = await prepareRuntimeWorkerGate(ctx, { taskBound: true }), root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const task = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Website naming task", status: "todo", assigneeAgentId: prepared.worker.id,
    description: `We need a product name before continuing the website. If this task has no naming question yet, create exactly one pending ask_user_questions interaction on it, authenticated as yourself with this actual run identity. Use idempotencyKey naming-${ctx.input.nonce}, title Website product name, continuationPolicy wake_assignee, and payload {version:1,supersedeOnUserComment:false,questionSet:{schema:"paperclip.question_set.v1",title:"Website product name",submitLabel:"Submit answers",questions:[{id:"name",prompt:"What is the product name?",answerMode:"text",required:true}]}}. This is an ordinary durable task question, not an artificial provider runtime-request receipt. Do not choose a name or create another interaction. If a human message wakes you while that naming question is still pending, run ${prepared.gate.command} once and wait for its actual output, then follow that output, leaving queued human answers for normal continuation. On a later normal continuation that delivers the submitted name response, save a non-plan website-delivery document using that name and a short semantic website outline, and complete the same task.` });
  const interactions = () => ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`);
  // The product parks a native turn as soon as its durable wake-based question is
  // saved, so the pending-input boundary is the saved yield, not a running process.
  const asked = await pollUntil({ label: "Real native naming question parks Morgan's turn on pending input", deadlineAt: Date.now() + 180_000,
    load: async () => { const runs = await ctx.allRuns(), questions = await interactions();
      const run = runs.length === 1 && runs[0]?.status === "succeeded" ? await ctx.input.api.get<PendingInputRun & { id: string }>(`/api/heartbeat-runs/${runs[0].id}`) : null;
      return { runs, questions, run }; },
    accept: v => v.runs.length === 1 && v.runs[0]?.agentId === prepared.worker.id && v.questions.length === 1 && v.questions[0]?.kind === "ask_user_questions"
      && v.questions[0].status === "pending" && v.questions[0].createdByAgentId === prepared.worker.id && v.questions[0].sourceRunId === v.runs[0].id && pendingInputYield(v.run, v.questions[0].id),
    reject: v => v.runs.length > 1 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) || (v.run && !(v.questions.length === 1 && pendingInputYield(v.run, v.questions[0]!.id)))
      ? "The actual question fixture did not park its native turn on one pending naming question" : undefined });
  const question = asked.questions[0]!, questionRunId = asked.runs[0]!.id;
  const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  const form = ctx.input.page.getByTestId("task-chat-composer-takeover"); await expect(form).toBeVisible(); await form.getByRole("button", { name: /^Dismiss / }).click();
  // An ordinary human message while the question stays open is normal discussion; it wakes Morgan into a new turn.
  await submitTaskReply(ctx.input.page, "Keep the hero section simple while the name is pending.");
  const busy = await pollUntil({ label: "Real Morgan turn active in its own tool process while the naming question stays pending", deadlineAt: Date.now() + 180_000,
    load: async () => ({ runs: await ctx.allRuns(), ready: await readRuntimeTaskGate(ctx, prepared.gate, task.id, prepared.worker.id), questions: await interactions() }),
    accept: v => v.runs.length === 2 && v.runs.some(row => row.id !== questionRunId && row.agentId === prepared.worker.id && row.status === "running") && v.ready === "waiting"
      && v.questions.length === 1 && v.questions[0]?.id === question.id && v.questions[0].status === "pending",
    reject: v => v.runs.length > 2 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) || v.runs.some(row => row.id !== questionRunId && row.status === "succeeded")
      || v.questions.length !== 1 || v.questions[0]?.status !== "pending" ? "The discussion turn did not stay active behind the pending naming question" : undefined });
  const workerRunId = busy.runs.find(row => row.id !== questionRunId)!.id;
  const messages = ["Preserve the original layout work.", "Use accessible labels."];
  for (const body of messages) await submitTaskReply(ctx.input.page, body);
  const queue = await pollUntil({ label: "Actual ordinary human comments remain separate behind running Morgan", deadlineAt: Date.now() + 20_000,
    load: () => ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`),
    accept: q => q.targetRunId === workerRunId && q.entries.length === 2 && q.entries.every(row => !row.source && messages.includes(row.comment.body)) });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (queue.entries.some(row => row.comment.authorUserId !== session.user.id || !row.canEdit || !row.canDiscard)) throw new Error("Ordinary queue is not actually owned by the signed-in human");
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { worker: prepared.worker, gate: prepared.gate, task, questionRunId, questionRunYielded: true, workerRunId, workerWasReallyWaiting: true, questionBefore: question, ordinaryQueueBefore: queue,
    humanId: session.user.id, ordinaryQueueOwned: true, ordinaryQueuedBeforeAnswer: true };
}, gradeApprovalQueue, {
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  authentication: "human-session", expectedRunCount: 5, minimumRunCount: 4, attemptTimeoutMs: 900_000, oracleVersion: "paperclip.chat-catalog.runtime.approval-delivery.v7",
  sourceFiles: ["chat-catalog-domains/runtime-approval-queue.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/steering.yaml"],
  async act(ctx, state) {
    const canonicalPhase = await pollUntil({ label: "Canonical naming answer guidance while real worker remains active", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.some(row => row.id === state.workerRunId && row.status === "running") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const task = state.task as Entity, question = state.questionBefore as IssueThreadInteraction, source = ctx.input.page.url(), endpoint = `/api/issues/${task.id}/queued-comments`;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const current = (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`)).find(row => row.id === question.id);
    if (current?.status === "answered") {
      const canonical = canonicalPhase.runs.find(row => row.agentId === ctx.input.fixtures.agent.id)!;
      const activity = await ctx.input.api.get<ActivityEvent[]>(`/api/issues/${task.id}/activity`);
      state.canonicalAnswerAttributed = current.resolvedByAgentId === ctx.input.fixtures.agent.id && activity.some(row => row.action === "issue.thread_interaction_answered" && row.agentId === ctx.input.fixtures.agent.id && row.runId === canonical.id && row.details?.interactionId === question.id);
      if (!state.canonicalAnswerAttributed) throw new Error("The existing answer was not authorized by this actual canonical native source run");
    } else {
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      const reopen = ctx.input.page.getByRole("button", { name: /answer|respond|question/i }).filter({ hasText: /answer|respond/i });
      if (!(await ctx.input.page.getByTestId("task-chat-composer-takeover").isVisible())) await reopen.first().click();
      const form = ctx.input.page.getByTestId("task-chat-composer-takeover"); await expect(form).toBeVisible();
      await form.getByTestId("question-text-answer-composer").locator('[contenteditable="true"],textarea').first().fill("Acorn");
      await form.getByRole("button", { name: /^(Submit|Send) answers$/ }).click(); state.humanAnswerSubmitted = true;
    }
    const answered = await pollUntil({ label: "Same real human naming interaction receives Acorn exactly once", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`), accept: rows => rows.find(row => row.id === question.id)?.status === "answered" });
    state.questionAfter = answered.find(row => row.id === question.id)!;
    // Mutate only ordinary comments. The interaction response is server-owned
    // and remains independently read after every mutation.
    let retained = true;
    async function verifyResponse() { const row = (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`)).find(row => row.id === question.id);
      retained &&= row?.status === "answered" && JSON.stringify(row.result) === JSON.stringify((state.questionAfter as IssueThreadInteraction).result); }
    // The person's two messages are what they edit, reorder and discard. The chat lead may also queue its own relay of the
    // answer on the task; that is the lead's comment, not the person's, so it is left alone and delivered normally.
    const humanId = String(state.humanId), leadId = ctx.input.fixtures.agent.id;
    let queue = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint); const ordinary = ordinaryApprovalEntries(queue, humanId);
    const unexpected = queue.entries.filter(row => !row.source && !ordinary.includes(row) && !leadRelayEntries(queue, leadId).includes(row));
    if (ordinary.length !== 2 || unexpected.length || !queue.queueId) throw new Error("The bound answer replaced rather than remained separate from the ordinary waiting queue");
    state.leadRelayCount = leadRelayEntries(queue, leadId).length;
    const target = ordinary[0]!, edited = `${target.comment.body} Retain the original layout note.`;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await ctx.input.page.getByTestId(`task-chat-queued-message-${target.comment.id}`).getByRole("button", { name: /^Queued message actions:/ }).click();
    await ctx.input.page.getByRole("menuitem", { name: "Edit message", exact: true }).click();
    await ctx.input.page.getByTestId("task-chat-composer-input").last().locator('[contenteditable="true"],textarea').first().fill(edited);
    await ctx.input.page.getByRole("button", { name: "Save queued message", exact: true }).click();
    queue = await pollUntil({ label: "Actual ordinary full-text edit persists independently of the accepted response", deadlineAt: Date.now() + 15_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => q.entries.some(row => row.comment.id === target.comment.id && row.comment.body === edited) });
    state.actualOrdinaryEdit = true; await verifyResponse();
    const order = ordinaryApprovalEntries(queue, humanId).map(row => row.comment.id).reverse(), moved = ordinaryApprovalEntries(queue, humanId)[1]!, wholeOrderBefore = queue.entries.map(row => row.comment.id);
    // Moving the person's second message up one place either persists exactly that swap or, when the queue refuses
    // to move messages around the bound response, leaves the whole queue order unchanged. Nothing else is accepted.
    const movedIndex = wholeOrderBefore.indexOf(moved.comment.id), swapped = [...wholeOrderBefore];
    if (movedIndex > 0) [swapped[movedIndex - 1], swapped[movedIndex]] = [swapped[movedIndex]!, swapped[movedIndex - 1]!];
    const handle = ctx.input.page.getByRole("button", { name: `Reorder queued message: ${moved.comment.body}`, exact: true });
    await handle.focus(); await handle.press("Space"); await handle.press("ArrowUp"); await handle.press("Space");
    const ids = (q: IssueQueuedCommentQueue) => q.entries.map(row => row.comment.id).join();
    queue = await pollUntil({ label: "Real keyboard queue reorder persists without replaying the decision", deadlineAt: Date.now() + 15_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => ids(q) === swapped.join() || ids(q) === wholeOrderBefore.join() })
      .catch(async error => {
        const shape = (q: IssueQueuedCommentQueue) => q.entries.map(row => ({ id: row.comment.id, source: row.source?.kind ?? null, person: row.comment.authorUserId === humanId, lead: row.comment.authorAgentId === leadId }));
        await ctx.input.evidence("runtime-approval-queue-reorder.json", { movedId: moved.comment.id, before: shape(queue), observed: shape(await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint)) });
        throw error;
      });
    if (ids(queue) === wholeOrderBefore.join()) {
      // Give a persisted swap a moment to land before calling the reorder refused.
      queue = await pollUntil({ label: "Queue reorder settles", deadlineAt: Date.now() + 5_000, load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => ids(q) === swapped.join() }).catch(() => queue);
    }
    state.actualOrdinaryReorder = movedIndex > 0 && ids(queue) === swapped.join();
    state.ordinaryReorderRestricted = !state.actualOrdinaryReorder && ids(queue) === wholeOrderBefore.join() && queue.entries.some(row => row.source?.kind === "interaction");
    await verifyResponse();
    for (const id of order) {
      await ctx.input.page.getByTestId(`task-chat-queued-discard-${id}`).click();
      await pollUntil({ label: "Supported human discard removes only this ordinary comment", deadlineAt: Date.now() + 15_000,
        load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => !q.entries.some(row => row.comment.id === id) });
      await verifyResponse();
    }
    state.actualOrdinaryDiscard = true; state.responseRetainedAcrossOrdinaryMutations = retained;
    const response = await pollUntil({ label: "Typed immutable naming answer stays apart from the queue after ordinary comments are removed", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => ordinaryApprovalEntries(q, humanId).length === 0 && approvalResponseListing(q, question.id, leadId) !== null })
      .catch(async error => {
        const observed = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint);
        await ctx.input.evidence("runtime-approval-queue-after-discard.json", { questionId: question.id, targetRunId: observed.targetRunId ?? null,
          entries: observed.entries.map(row => ({ id: row.comment.id, source: row.source?.kind ?? null, interactionId: row.source?.interactionId ?? null, person: row.comment.authorUserId === humanId, lead: row.comment.authorAgentId === leadId })),
          interaction: (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`)).filter(row => row.id === question.id).map(row => ({ status: row.status, dismissed: !!(row as { dismissedAt?: unknown }).dismissedAt })) });
        throw error;
      }); state.responseQueue = response; state.responseListing = approvalResponseListing(response, question.id, leadId);
    // Try to rewrite the answer through the queue's edit route; whichever wake is listed, the saved answer must not change.
    const immutable = await ctx.input.page.request.patch(`${endpoint}/${question.id}`, { data: { queueId: response.queueId, revision: response.revision, body: "Replace the accepted name with an unauthorized comment edit" }, headers: { Origin: new URL(ctx.input.page.url()).origin } });
    const refused = immutable.status() >= 400 && immutable.status() < 500 && immutable.status() !== 401; await immutable.dispose(); await verifyResponse();
    state.responseUneditable = refused && retained;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    if (state.responseListing === "listed") {
      await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${question.id}`)).toBeVisible();
      await expect(ctx.input.page.getByTestId(`task-chat-queued-discard-${question.id}`)).toBeDisabled(); state.responseListedImmutable = true;
    }
    await ctx.input.capture("actual-immutable-answer-queue", "Bound Acorn answer remains distinct from edited, reordered and removed ordinary comments", "runtime-approval-queue.png");
    state.initialMarker = `Earlier website work ${ctx.input.nonce}`;
    await writeFile((state.gate as { gate: string }).gate, `This turn is settling while the naming question waits. Save a task document with the exact reference ${state.initialMarker} preserving earlier website work, then finish this turn normally. Do not manufacture or pre-consume a name decision; leave the actual accepted response for normal Paperclip admission.`, "utf8");
    type FullRun = { id: string; contextSnapshot?: { interactionId?: string; wakeCommentIds?: unknown }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } };
    const worker = (state.worker as Entity).id;
    const successors = async () => {
      const runs = await ctx.allRuns(), comments = await ctx.input.api.get<Array<{ id: string; authorAgentId?: string | null }>>(`/api/issues/${task.id}/comments`);
      const later = await Promise.all(runs.filter(row => row.agentId === worker && row.id !== state.workerRunId && row.id !== state.questionRunId)
        .map(row => ctx.input.api.get<FullRun>(`/api/heartbeat-runs/${row.id}`)));
      return { runs, later, split: classifyApprovalSuccessors(later, question.id, new Set(comments.filter(row => row.authorAgentId === leadId).map(row => row.id))) };
    };
    const done = await pollUntil({ label: "One normal successor receives actual immutable name response", deadlineAt: Date.now() + 300_000,
      load: async () => ({ ...(await successors()), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`) }),
      accept: v => v.split.bound.length === 1 && v.runs.every(row => row.status === "succeeded") && v.queue.entries.length === 0 && v.task.status === "done",
      reject: v => v.runs.length > 5 || v.split.bound.length > 1 || v.split.other.length > 0 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Accepted decision delivery failed or replayed work" : undefined });
    state.consumingRunCount = done.split.bound.length; state.consumerRunId = done.split.bound[0]; state.relayRunCount = done.split.relay.length;
    state.relayRunIds = done.split.relay; state.unexpectedSuccessorRunCount = done.split.other.length;
    const full = done.later.find(row => row.id === state.consumerRunId);
    state.responseNativeInputBound = full?.contextSnapshot?.interactionId === question.id && full.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(question.id) === true && full.runnerProfileJson.nativeExecutionInput.task.prompt.includes("Acorn");
    state.queueEmptyAfterDelivery = done.queue.entries.length === 0;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state);
    const question = state.questionBefore as IssueThreadInteraction; state.questionAfter = (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${(state.task as Entity).id}/interactions`)).find(row => row.id === question.id);
    const successorRunIds = [state.consumerRunId, ...((state.relayRunIds as string[] | undefined) ?? [])].filter((id): id is string => typeof id === "string");
    state.acornWorkSource = acornWorkSource({ revisions: o.revisions, documents: o.documents, workerId: (state.worker as Entity).id, successorRunIds,
      settlingRunId: String(state.workerRunId), answeredAt: (state.questionAfter as IssueThreadInteraction | undefined)?.resolvedAt });
    state.actualAcornResult = state.acornWorkSource !== null;
    state.initialWorkRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && (row.body ?? "").includes(String(state.initialMarker))); return o; },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible(); await expect(ctx.input.page.getByTestId("task-chat-queued-messages")).toHaveCount(0); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
