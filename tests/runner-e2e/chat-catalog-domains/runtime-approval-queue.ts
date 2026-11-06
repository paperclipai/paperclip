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
export function acornNamingDirection(reply: string) {
  if (/\b(?:not|instead of|rather than|avoid|reject)\s+(?:the name\s+)?Acorn\b|\bAcorn\s+(?:is|was|would be)\s+(?:the\s+)?(?:wrong|incorrect|invalid|rejected)\b/i.test(reply)) return false;
  const selectedNames = [...reply.matchAll(/\b(?:[Uu]se|[Cc]hoose|[Nn]ame it|[Cc]all it|[Aa]nswer with)\s+["']?([A-Z][a-zA-Z0-9-]*)/g)].filter(match => !/\b(?:not|don't|avoid)\s*$/i.test(reply.slice(Math.max(0, (match.index ?? 0) - 12), match.index))).map(match => match[1]!);
  if (selectedNames.some(name => !["Acorn", "The", "Submit", "That", "Its", "This"].includes(name))) return false;
  return /\bAcorn\b/i.test(reply) && /question|answer|respond|decision|nam(?:e|ing)/i.test(reply);
}
export function ordinaryApprovalEntries(queue: Pick<IssueQueuedCommentQueue, "entries">) { return queue.entries.filter(row => !row.source); }
export function gradeApprovalQueue(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-question-response-and-ordinary-queue-evidence", !!o, "The actual native question, human response, separate queue mutations and once-only consuming native input are required."); if (!o) return c.result();
  const s = o.state, question = s.questionBefore as IssueThreadInteraction, answered = s.questionAfter as IssueThreadInteraction;
  c.add("genuine-prior-worker-question-and-saved-comments", !!question && question.kind === "ask_user_questions" && question.status === "pending" && question.issueId === (s.task as Entity).id
    && question.createdByAgentId === (s.worker as Entity).id && question.sourceRunId === s.workerRunId && s.workerWasReallyWaiting === true
    && s.ordinaryQueueOwned === true && s.ordinaryQueuedBeforeAnswer === true,
  "Morgan's actual native turn asks the naming question and remains active while the real human's separate ordinary comments are pending.");
  const results = answered?.result as { answers?: Array<{ questionId?: string; otherText?: string }> } | null;
  c.add("actual-bound-human-answer-preserved", answered?.id === question.id && answered.status === "answered" && ((answered.resolvedByUserId === s.humanId && !answered.resolvedByAgentId && s.humanAnswerSubmitted === true) || (answered.resolvedByAgentId === o.leadId && s.canonicalAnswerAttributed === true))
    && JSON.stringify(answered.payload) === JSON.stringify(question.payload) && results?.answers?.some(row => row.questionId === "name" && row.otherText === "Acorn") === true
    && s.responseRetainedAcrossOrdinaryMutations === true && s.responseUneditable === true,
  "Acorn remains the same immutable typed interaction response, distinct from the editable/deletable ordinary comment queue.");
  c.add("human-guidance-and-real-ordinary-mutations", acornNamingDirection(String(s.queryReply))
    && (s.canonicalAnswerAttributed === true || !/I(?:'ve| have)? (?:already )?(?:answered|submitted|accepted)/i.test(String(s.queryReply)))
    && s.actualOrdinaryEdit === true && (s.actualOrdinaryReorder === true || s.ordinaryReorderRestricted === true) && s.actualOrdinaryDiscard === true && (s.humanAnswerSubmitted === true || s.canonicalAnswerAttributed === true),
  "Canonical chat identifies the intended answer and actual human response control; editing, ordering and discarding ordinary messages cannot impersonate or cancel it.");
  const response = s.responseQueue as IssueQueuedCommentQueue;
  c.add("response-own-delivery-semantics-and-once-only-admission", response?.entries.length === 1 && response.entries[0]?.source?.kind === "interaction"
    && response.entries[0].source.interactionId === question.id && response.entries[0].canEdit === false && response.entries[0].canDiscard === false
    && s.consumingRunCount === 1 && s.responseNativeInputBound === true && s.queueEmptyAfterDelivery === true
    && o.runs.length === 3 && o.runs.every(row => row.status === "succeeded") && o.tasks.length === 1 && s.actualAcornResult === true && s.initialWorkRetained === true,
  "After the original owner settles, exactly one eligible native continuation receives the bound answer and saves actual Acorn work without replaying or losing it.");
  return c.result();
}
export const runtimeApprovalQueueCases = [runtimeDefinition("steering.approval-delivery", async ctx => {
  const prepared = await prepareRuntimeWorkerGate(ctx, { taskBound: true }), root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const task = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Website naming task", status: "todo", assigneeAgentId: prepared.worker.id,
    description: `We need a product name before continuing the website. During this actual native run, create exactly one pending ask_user_questions interaction using the supported public issue interaction API, authenticated as yourself with this actual run identity. Use idempotencyKey naming-${ctx.input.nonce}, title Website product name, continuationPolicy wake_assignee, and payload {version:1,supersedeOnUserComment:false,questionSet:{schema:"paperclip.question_set.v1",title:"Website product name",submitLabel:"Submit answers",questions:[{id:"name",prompt:"What is the product name?",answerMode:"text",required:true}]}}. This is an ordinary durable task question, not an artificial provider runtime-request receipt. Do not choose a name or create another interaction. After the real question is saved, run ${prepared.gate.command} once and wait for its actual output. Then save the returned pending-work note as a task document and finish this current turn normally, leaving queued human answers for normal continuation. On a later normal continuation, read the real submitted name response, save a non-plan website-delivery document using that name and a short semantic website outline, and complete the same task.` });
  const waiting = await pollUntil({ label: "Real native naming question while worker waits in its own tool process", deadlineAt: Date.now() + 180_000,
    load: async () => ({ runs: await ctx.allRuns(), ready: await readRuntimeTaskGate(ctx, prepared.gate, task.id, prepared.worker.id), questions: await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`) }),
    accept: v => v.runs.length === 1 && v.runs[0]?.agentId === prepared.worker.id && v.runs[0].status === "running" && v.ready === "waiting"
      && v.questions.length === 1 && v.questions[0]?.kind === "ask_user_questions" && v.questions[0].status === "pending" && v.questions[0].createdByAgentId === prepared.worker.id && v.questions[0].sourceRunId === v.runs[0].id,
    reject: v => v.runs.length > 1 || v.runs.some(row => ["failed", "cancelled", "succeeded", "timed_out"].includes(row.status)) ? "The actual question fixture did not reach its running pending-input boundary" : undefined });
  const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  const form = ctx.input.page.getByTestId("task-chat-composer-takeover"); await expect(form).toBeVisible(); await form.getByRole("button", { name: /^Dismiss / }).click();
  const messages = ["Preserve the original layout work.", "Use accessible labels."];
  for (const body of messages) await submitTaskReply(ctx.input.page, body);
  const queue = await pollUntil({ label: "Actual ordinary human comments remain separate behind running Morgan", deadlineAt: Date.now() + 20_000,
    load: () => ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`), accept: q => q.entries.length === 2 && q.entries.every(row => !row.source && messages.includes(row.comment.body)) });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (queue.entries.some(row => row.comment.authorUserId !== session.user.id || !row.canEdit || !row.canDiscard)) throw new Error("Ordinary queue is not actually owned by the signed-in human");
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { worker: prepared.worker, gate: prepared.gate, task, workerRunId: waiting.runs[0]!.id, workerWasReallyWaiting: true, questionBefore: waiting.questions[0]!, ordinaryQueueBefore: queue,
    humanId: session.user.id, ordinaryQueueOwned: true, ordinaryQueuedBeforeAnswer: true };
}, gradeApprovalQueue, {
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  authentication: "human-session", expectedRunCount: 3, attemptTimeoutMs: 900_000,
  sourceFiles: ["chat-catalog-domains/runtime-approval-queue.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/steering.yaml"],
  async act(ctx, state) {
    const canonicalPhase = await pollUntil({ label: "Canonical naming answer guidance while real worker remains active", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") });
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
    let queue = await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint); const ordinary = ordinaryApprovalEntries(queue);
    if (ordinary.length !== 2 || !queue.queueId) throw new Error("The bound answer replaced rather than remained separate from the ordinary waiting queue");
    const target = ordinary[0]!, edited = `${target.comment.body} Retain the original layout note.`;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await ctx.input.page.getByTestId(`task-chat-queued-message-${target.comment.id}`).getByRole("button", { name: /^Queued message actions:/ }).click();
    await ctx.input.page.getByRole("menuitem", { name: "Edit message", exact: true }).click();
    await ctx.input.page.getByTestId("task-chat-composer-input").last().locator('[contenteditable="true"],textarea').first().fill(edited);
    await ctx.input.page.getByRole("button", { name: "Save queued message", exact: true }).click();
    queue = await pollUntil({ label: "Actual ordinary full-text edit persists independently of the accepted response", deadlineAt: Date.now() + 15_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => q.entries.some(row => row.comment.id === target.comment.id && row.comment.body === edited) });
    state.actualOrdinaryEdit = true; await verifyResponse();
    const order = ordinaryApprovalEntries(queue).map(row => row.comment.id).reverse(), moved = ordinaryApprovalEntries(queue)[1]!, wholeOrderBefore = queue.entries.map(row => row.comment.id);
    const mixed = queue.entries.some(row => row.source?.kind === "interaction");
    const handle = ctx.input.page.getByRole("button", { name: `Reorder queued message: ${moved.comment.body}`, exact: true });
    await handle.focus(); await handle.press("Space"); await handle.press("ArrowUp"); await handle.press("Space");
    queue = await pollUntil({ label: "Real keyboard queue reorder persists without replaying the decision", deadlineAt: Date.now() + 15_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => mixed ? q.entries.map(row => row.comment.id).join() === wholeOrderBefore.join() : ordinaryApprovalEntries(q).map(row => row.comment.id).join() === order.join() });
    state.actualOrdinaryReorder = !mixed; state.ordinaryReorderRestricted = mixed && queue.entries.map(row => row.comment.id).join() === wholeOrderBefore.join(); await verifyResponse();
    for (const id of order) {
      await ctx.input.page.getByTestId(`task-chat-queued-discard-${id}`).click();
      await pollUntil({ label: "Supported human discard removes only this ordinary comment", deadlineAt: Date.now() + 15_000,
        load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => !q.entries.some(row => row.comment.id === id) });
      await verifyResponse();
    }
    state.actualOrdinaryDiscard = true; state.responseRetainedAcrossOrdinaryMutations = retained;
    const response = await pollUntil({ label: "Typed immutable naming answer remains queued after ordinary comments are removed", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), accept: q => q.entries.length === 1 && q.entries[0]?.source?.interactionId === question.id }); state.responseQueue = response;
    const immutable = await ctx.input.page.request.patch(`${endpoint}/${question.id}`, { data: { queueId: response.queueId, revision: response.revision, body: "Replace the accepted name with an unauthorized comment edit" } });
    state.responseUneditable = [403, 409].includes(immutable.status()); await immutable.dispose(); await verifyResponse();
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId(`task-chat-queued-message-${question.id}`)).toBeVisible();
    await expect(ctx.input.page.getByTestId(`task-chat-queued-discard-${question.id}`)).toBeDisabled();
    await ctx.input.capture("actual-immutable-answer-queue", "Bound Acorn answer remains distinct from edited, reordered and removed ordinary comments", "runtime-approval-queue.png");
    state.initialMarker = `Earlier website work ${ctx.input.nonce}`;
    await writeFile((state.gate as { gate: string }).gate, `The current pending-input turn is settling. Save a task document with the exact reference ${state.initialMarker} preserving earlier website work, then finish this turn normally. Do not manufacture or pre-consume a name decision; leave the actual accepted response for normal Paperclip admission.`, "utf8");
    const done = await pollUntil({ label: "One normal successor receives actual immutable name response", deadlineAt: Date.now() + 240_000,
      load: async () => ({ runs: await ctx.allRuns(), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint), task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`) }),
      accept: v => v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") && v.queue.entries.length === 0 && v.task.status === "done",
      reject: v => v.runs.length > 3 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Accepted decision delivery failed or replayed work" : undefined });
    const consumers = done.runs.filter(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId); state.consumingRunCount = consumers.length; state.consumerRunId = consumers[0]?.id;
    const full = consumers[0] && await ctx.input.api.get<{ contextSnapshot?: { interactionId?: string }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${consumers[0].id}`);
    state.responseNativeInputBound = full?.contextSnapshot?.interactionId === question.id && full.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(question.id) === true && full.runnerProfileJson.nativeExecutionInput.task.prompt.includes("Acorn");
    state.queueEmptyAfterDelivery = done.queue.entries.length === 0;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state);
    const question = state.questionBefore as IssueThreadInteraction; state.questionAfter = (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${(state.task as Entity).id}/interactions`)).find(row => row.id === question.id);
    state.actualAcornResult = o.revisions.some(row => row.createdByRunId === state.consumerRunId && row.createdByAgentId === (state.worker as Entity).id && /Acorn/i.test(row.body ?? "") && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
    state.initialWorkRetained = o.revisions.some(row => row.createdByRunId === state.workerRunId && (row.body ?? "").includes(String(state.initialMarker))); return o; },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible(); await expect(ctx.input.page.getByTestId("task-chat-queued-messages")).toHaveCount(0); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
