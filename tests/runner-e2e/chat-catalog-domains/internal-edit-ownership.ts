import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { fixtureWorker } from "./internal-definition.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { checks, entity, hasLink, observation, observeInternal, sameTask, type Entity, type InternalObservation } from "./internal-support.js";
interface OwnedTask extends Entity { executionRunId?: string | null; checkoutRunId?: string | null }
interface EditOwnership extends InternalObservation { currentTask: OwnedTask; phaseReply: string; sourceComments?: Entity[]; assignmentDenials?: { runId: string; taskId: string; assigneeId: string; callId: string; reason: string }[] }
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function expectedEditReassignmentCancellation(value: unknown): { runId: string; taskId: string; workerId: string; sourceRunId: string } | undefined {
  const o = observation(value) as EditOwnership | undefined; if (!o?.currentTask || !Array.isArray(o.sourceComments)) return;
  const first = observation(o.state.firstEdit); const held = o.state.heldTask as OwnedTask | undefined; const prior = o.state.heldRun as Entity | undefined;
  const riley = o.state.riley as Entity | undefined; const morgan = o.state.worker as Entity | undefined; const query = o.state.canonicalEditQuery;
  if (!first || !held || !prior || !riley || !morgan || typeof query !== "string" || !Array.isArray(o.state.gateCalls) || !(o.state.gateCalls as { authorized?: boolean }[]).some(call => call.authorized)) return;
  const requests = o.sourceComments.filter(row => !row.authorAgentId && row.body === query); if (requests.length !== 2 || requests[0]?.id === requests[1]?.id) return;
  const request = requests[1]!; const requestAt = Date.parse(request.createdAt ?? "");
  const initialRuns = new Set(first.runs.map(run => run.id));
  const source = o.runs.find(run => run.agentId === o.leadId && run.status === "succeeded" && !initialRuns.has(run.id)
    && (run.contextSnapshot?.wakeCommentId === request.id || Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(request.id)));
  const cancelled = o.runs.find(run => run.id === prior.id && run.agentId === riley.id && run.companyId === o.companyId && run.status === "cancelled" && run.errorCode === "issue_reassigned"
    && (run.contextSnapshot?.issueId === held.id || run.contextSnapshot?.taskId === held.id));
  if (!source || !cancelled || held.assigneeAgentId !== riley.id || held.executionRunId !== prior.id) return;
  const result = record(cancelled.resultJson); const stop = record(result.nativeCancellation); const stoppedAt = Date.parse(String(stop.acknowledgedAt ?? ""));
  if (result.reassignmentStopConfirmed !== true || stop.schema !== "paperclip.native-cancellation.v1" || stop.dispatchState !== "acknowledged"
    || stop.runId !== cancelled.id || stop.issueId !== held.id || stop.companyId !== o.companyId || !Number.isFinite(requestAt) || !Number.isFinite(stoppedAt) || stoppedAt < requestAt) return;
  const mutation = o.activity.find(row => row.entityId === held.id && row.agentId === o.leadId && (row as Entity & { runId?: string }).runId === source.id
    && row.companyId === o.companyId && row.actorType === "agent" && row.actorId === o.leadId
    && (row.action === "issue.reassigned" && row.details?.changed === true && row.details?.previousAssigneeAgentId === riley.id && row.details?.assigneeAgentId === morgan.id
      || row.action === "issue.updated" && record(row.details?._previous).assigneeAgentId === riley.id && row.details?.assigneeAgentId === morgan.id)
    && Date.parse(row.createdAt ?? "") >= stoppedAt);
  const priority = o.activity.some(row => row.entityId === held.id && row.agentId === o.leadId && (row as Entity & { runId?: string }).runId === source.id && row.action === "issue.updated"
    && row.companyId === o.companyId && row.actorType === "agent" && row.actorId === o.leadId
    && row.details?.priority === "high" && Date.parse(row.createdAt ?? "") >= requestAt);
  if (!mutation || !priority || o.currentTask.id !== held.id || o.currentTask.priority !== "high" || o.currentTask.assigneeAgentId !== morgan.id
    || o.currentTask.executionRunId === cancelled.id || o.currentTask.checkoutRunId === cancelled.id || o.tasks.length !== 1 || o.tasks[0]?.id !== held.id
    || !sameTask(held, o.currentTask, ["priority", "assigneeAgentId", "status"])) return;
  return { runId: cancelled.id, taskId: held.id, workerId: riley.id, sourceRunId: source.id };
}
export function assignmentDenials(events: unknown[], runId: string, taskId: string, assigneeId: string) {
  const calls = new Set<string>(); const denied: NonNullable<EditOwnership["assignmentDenials"]> = [];
  for (const raw of events) {
    const outer = record(raw); const e = record(record(outer.payload).prpEvent);
    if (outer.runId !== runId || e.runId !== runId || e.sourceEventId !== outer.sourceEventId || e.schema !== "paperclip.prp.event.v1") continue;
    const p = record(e.payload); const item = record(p.item); if (p.kind !== "dynamicToolCall" || item.id !== e.itemId || typeof item.id !== "string") continue;
    const input = record(item.input);
    if (e.eventType === "item.started" && item.type === "tool_use" && item.name === "reassign_task" && input.taskId === taskId && input.assigneeActorId === assigneeId) calls.add(item.id);
    if (e.eventType === "item.completed" && item.type === "tool_result" && item.tool_use_id === item.id && calls.has(item.id) && item.is_error === true && typeof item.error === "string"
      && /checkout|ownership|reassignment_(?:conflict|state_denied|stop_unavailable|stop_unconfirmed)|(?:cannot|unable|failed|unconfirmed)[^.\n]*stop|already (?:claimed|running)/i.test(item.error)) denied.push({ runId, taskId, assigneeId, callId: item.id, reason: item.error });
  }
  return denied;
}
export function gradeEditOwnership(value: unknown, initialGrade: ChatCatalogCase["grade"]) {
  const c = checks(); const o = observation(value) as EditOwnership | undefined;
  c.add("both-edit-boundary-contexts", !!o && !!o.currentTask && typeof o.phaseReply === "string" && !!o.state.firstEdit, "The initial permitted edit and actual later ownership-denied context must both be independently observed."); if (!o || !o.currentTask || typeof o.phaseReply !== "string") return c.result();
  const first = observation(o.state.firstEdit); c.add("permitted-primary-edits-fully-validated", !!first && initialGrade(first).passed, "The first canonical request really saves the intended High priority and Morgan assignment before the separately established denial context.");
  const held = o.state.heldTask as OwnedTask | undefined; const riley = o.state.riley as Entity | undefined; const run = o.state.heldRun as Entity | undefined;
  const workers = o.runs.filter(row => row.agentId !== o.leadId);
  if (workers.some(row => row.id === run?.id && row.status === "cancelled")) {
    const receipt = expectedEditReassignmentCancellation(o);
    c.add("exact-authorized-reassignment-cancellation", !!receipt, "Only the exact earlier Riley checkout may be cancelled, after the second canonical request, with acknowledged stop, final CEO audit and independently saved High/Morgan assignment.");
    const morgan = entity(o.state, "worker"); const admitted = workers.filter(row => row.id !== run?.id);
    c.add("single-real-morgan-admission-or-honest-pending", workers.length >= 1 && workers.length <= 2 && admitted.every(row => row.agentId === morgan.id && ["queued", "running", "succeeded"].includes(row.status)
      && (row.contextSnapshot?.issueId === o.currentTask.id || row.contextSnapshot?.taskId === o.currentTask.id))
      && admitted.every(row => row.status !== "running" || o.currentTask.executionRunId === row.id)
      && (o.currentTask.status !== "done" || admitted.some(row => row.status === "succeeded")) && o.currentTask.status !== "cancelled", "Any new worker execution belongs only to the saved Morgan task; Morgan admission is not required when actual accounting prevents starting it, and completion cannot be invented.");
    const falseStart = o.phaseReply.split(/[.\n;]/).some(part => /\bMorgan\b[^.\n]*(?:has started|is (?:running|working)|is active)/i.test(part) && !/\b(?:not|cannot|can't|pending|wait|hasn't|has not)\b/i.test(part));
    c.add("truthful-saved-changes-and-new-work-boundary", /\bhigh\b/i.test(o.phaseReply) && /\bpriority\b/i.test(o.phaseReply) && /\bMorgan\b/.test(o.phaseReply)
      && /\b(?:assigned|reassigned|assignment|moved)\b/i.test(o.phaseReply) && (admitted.some(row => ["running", "succeeded"].includes(row.status)) || !falseStart)
      && !/\b(?:assignment|reassignment)[^.\n]*\b(?:reverted|denied|not saved)\b/i.test(o.phaseReply), "The final phase distinguishes a committed assignment from pending new-run admission instead of claiming the saved mutation was denied or that unstarted work is running.");
    c.add("same-task-no-workaround", o.tasks.length === 1 && hasLink(o, "issues", o.currentTask), "The graceful handoff keeps the single task and its actual source link.");
    return c.result();
  }
  c.add("actual-riley-ownership-not-stolen", !!held && !!riley && !!run && held.assigneeAgentId === riley.id && held.executionRunId === run.id
    && sameTask(held, o.currentTask, ["priority"]) && o.currentTask.executionRunId === run.id && o.currentTask.checkoutRunId === held.checkoutRunId
    && workers.length === 1 && workers[0]?.agentId === riley.id && workers[0]?.id === run.id && workers[0]?.status === "running"
    && Array.isArray(o.state.gateCalls) && (o.state.gateCalls as Array<{ authorized?: boolean }>).some(row => row.authorized),
    "Riley's actual running checkout remains the sole admitted execution; Morgan is not started and ownership is not overwritten.");
  const denial = /\b(?:cannot|can't|couldn't|unable|denied|blocked|pending|wait|until|not (?:yet )?assigned)\b/i.test(o.phaseReply);
  const falseAssign = o.phaseReply.split(/[.\n;]|,\s*(?:but|and)\s*/).some(part => /\b(?:assigned|reassigned|moved)\b[^.\n]*\b(?:to )?Morgan\b|\bMorgan\b[^.\n]*(?:has started|is (?:running|working)|now owns)/i.test(part)
    && !/\b(?:cannot|can't|couldn't|not|pending|denied|until|would|could)\b/i.test(part));
  c.add("final-phase-assignment-boundary-explained", denial && /\bRiley\b/.test(o.phaseReply) && /\b(?:checkout|execution|running|ownership|in.progress)\b/i.test(o.phaseReply) && !falseAssign,
    "The repeated canonical request identifies the newly observed Riley execution and truthfully separates denied reassignment from accepted work.");
  c.add("actual-ownership-denial-required", (o.assignmentDenials ?? []).some(proof => proof.taskId === o.currentTask.id && proof.assigneeId === entity(o.state, "worker").id && o.runs.some(run => run.id === proof.runId && run.agentId === o.leadId && !(first?.runs ?? []).some(prior => prior.id === run.id))), "A denied branch requires an actual final-phase native assignment attempt rejected at the ownership boundary; a held but stoppable checkout alone is not a denial.");
  const firstRunIds = new Set(first?.runs.map(run => run.id) ?? []); const finalRunIds = new Set(o.runs.filter(run => run.agentId === o.leadId && !firstRunIds.has(run.id)).map(run => run.id));
  const prioritySaved = o.currentTask.priority === "high";
  const claimsSavedPriority = o.phaseReply.split(/[.\n;]|,\s*but\s*/).some(part => /\b(?:set|saved|updated|changed|now)\b[^.\n]*\bhigh\b|\bhigh\b[^.\n]*\b(?:saved|set|updated)\b/i.test(part)
    && !/\b(?:not|cannot|can't|couldn't|denied|pending)\b/i.test(part));
  c.add("actual-priority-outcome-distinguished", /\bpriority\b/i.test(o.phaseReply) && (prioritySaved ? claimsSavedPriority
    && o.activity.some(row => row.action === "issue.updated" && row.entityId === o.currentTask.id && row.agentId === o.leadId && row.details?.priority === "high" && finalRunIds.has((row as Entity & { runId?: string }).runId ?? ""))
    : o.currentTask.priority === held?.priority && denial && !claimsSavedPriority),
    "If priority was independently saved it is proven and reported; if the ownership boundary denied it too, chat cannot claim that save.");
  c.add("same-task-no-workaround", o.tasks.length === 1 && o.tasks[0]?.id === o.currentTask.id && hasLink(o, "issues", o.currentTask), "The conditional refusal does not create a duplicate task or lose the actual source link.");
  return c.result();
}
export function withEditOwnership(primary: ChatCatalogCase): ChatCatalogCase {
  let gate: Awaited<ReturnType<typeof startRunBriefGate>> | undefined;
  return { ...primary, coverageGaps: [], expectedRunCount: 4, minimumRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 600000,
    runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1, expectedWorkerCancellation: "owned-task-reassignment" },
    expectedCancelledWorkerRun: expectedEditReassignmentCancellation,
    sourceFiles: [...primary.sourceFiles, "chat-catalog-domains/internal-edit-ownership.ts", "chat-catalog-domains/internal-run-brief.ts", "../e2e/fetch-allowed-port.ts", "run-observations.ts"],
    async setup(ctx) { const state = await primary.setup(ctx); const riley = await fixtureWorker(ctx); await ctx.input.api.patch(`/api/agents/${riley.id}`, { name: "Riley" }); return { ...state, riley, canonicalEditQuery: ctx.scenario.query }; },
    grade: value => gradeEditOwnership(value, primary.grade),
    async act(ctx, state) {
      const first = await pollUntil({ label: "Fully validated initial permitted property edit", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000),
        load: () => observeInternal(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" && primary.grade(o).passed) });
      state.firstEdit = { ...first, state: structuredClone(state) }; const riley = entity(state, "riley"); const t = entity(state, "task");
      await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { scopeType: "agent", scopeId: riley.id, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
      gate = await startRunBriefGate(ctx, riley.id);
      try {
        await ctx.input.api.patch(`/api/issues/${t.id}`, { assigneeAgentId: riley.id, priority: "medium", status: "todo",
          description: "Read the Website Brief app's read_website_brief tool before doing any implementation. Its actual source may still be pending; wait for that result rather than inventing its contents." });
        const held = await pollUntil({ label: "Actual later Riley checkout for the ownership-denied variant", deadlineAt: Date.now() + 150000,
          load: async () => ({ task: await ctx.input.api.get<OwnedTask>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
          accept: value => gate!.calls.length > 0 && value.runs.length === 2 && value.runs.some(run => run.agentId === riley.id && run.status === "running" && run.id === value.task.executionRunId),
          reject: value => value.runs.some(run => run.agentId === riley.id && ["failed", "cancelled", "succeeded", "timed_out"].includes(run.status)) ? "The conditional real checkout ended before the denial request" : undefined });
        state.heldTask = held.task; state.heldRun = held.runs.find(run => run.agentId === riley.id); state.gateCalls = structuredClone(gate.calls);
        await ctx.input.evidence("chat-catalog-edit-properties-boundary-variant.json", { firstEdit: state.firstEdit, heldTask: state.heldTask, heldRun: state.heldRun, gateCalls: state.gateCalls });
        const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, ctx.scenario.query, chatCatalogNativePhaseRemainingBudget(ctx));
      } catch (error) { await gate.close(); gate = undefined; throw error; }
    },
    async observe(ctx, state): Promise<EditOwnership> {
      const o = await observeInternal(ctx, state); const first = observation(state.firstEdit); const ids = new Set(first?.runs.map(run => run.id) ?? []);
      const rows = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
      const denials: NonNullable<EditOwnership["assignmentDenials"]> = [];
      for (const run of o.runs.filter(run => run.agentId === o.leadId && !ids.has(run.id))) { const events = await collectRunEvents((after, limit) => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${after}&limit=${limit}`)); denials.push(...assignmentDenials(events, run.id, entity(state, "task").id, entity(state, "worker").id)); }
      return { ...o, sourceComments: rows, assignmentDenials: denials, currentTask: await ctx.input.api.get<OwnedTask>(`/api/issues/${entity(state, "task").id}`), phaseReply: rows.filter(row => row.authorAgentId === o.leadId && !ids.has(row.createdByRunId ?? "") && o.runs.some(run => run.id === row.createdByRunId)).map(row => row.body ?? "").join("\n") };
    },
    async cleanup(ctx, state) { try { await primary.cleanup?.(ctx, state); } finally { await gate?.close(); gate = undefined; } },
  };
}
