import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { createRoutineSchema } from "../../../packages/shared/src/validators/routine.js";
import type { RoutineDetail, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { checks, hasLink, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { integratorDefinition, observeInternal, inspectResult, resultHref } from "./integrator-support.js";

/** One completed product tool execution, as recorded in the run's durable event stream. */
export interface InvocationToolRead { runId: string; name: string; at: string; output: string }
interface InvocationObservation extends InternalObservation { routine: RoutineDetail; invocations: RoutineRunSummary[]; outputComments: Entity[]; toolReads?: InvocationToolRead[] }
async function invocationToolReads(ctx: ChatCatalogContext, runs: InternalObservation["runs"]): Promise<InvocationToolRead[]> {
  const reads: InvocationToolRead[] = [];
  for (const run of runs) {
    const events = await collectRunEvents<{ seq?: number; createdAt?: string; payload?: Record<string, unknown> | null }>((afterSeq, limit) =>
      ctx.input.api.getRunObservation(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    for (const event of events) {
      const prp = event.payload?.prpEvent as { eventType?: string; payload?: { name?: unknown; status?: unknown; output?: unknown } } | undefined;
      if (prp?.eventType !== "tool.execution.completed" || prp.payload?.status !== "completed" || typeof prp.payload.name !== "string") continue;
      const output = typeof prp.payload.output === "string" ? prp.payload.output : JSON.stringify(prp.payload.output ?? "");
      reads.push({ runId: run.id, name: prp.payload.name, at: event.createdAt ?? "", output: output.slice(0, 8192) });
    }
  }
  return reads;
}
async function observeInvocation(ctx: ChatCatalogContext, state: Record<string, unknown>, withToolReads = false): Promise<InvocationObservation> {
  const base = await observeInternal(ctx, state); const id = (state.routine as RoutineDetail).id;
  const invocations = await ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${id}/runs`);
  return { ...base, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${id}`), invocations,
    outputComments: invocations[0]?.linkedIssueId ? await ctx.input.api.get<Entity[]>(`/api/issues/${invocations[0].linkedIssueId}/comments?order=asc`) : [],
    ...(withToolReads ? { toolReads: await invocationToolReads(ctx, base.runs) } : {}) };
}
function invocationObservation(value: unknown): InvocationObservation | undefined {
  const o = value as InvocationObservation;
  return observation(value) && !!o.routine && Array.isArray(o.invocations) && Array.isArray(o.outputComments) ? o : undefined;
}
/** Narrow contradiction guard for the first answer only: a sentence that states the summary,
 * run or task as already done, without negation or a future/conditional frame. It never makes
 * a valid answer depend on particular wording; it only refuses an explicit premature claim. */
function prematureCompletionClaim(reply: string) {
  return reply.split(/(?<=[.!?])\s+|\n+/).some(sentence =>
    /\b(?:summary|execution|task|run)\b[^.!?\n]{0,50}\b(?:completed|finished|succeeded|is ready|is done)\b/i.test(sentence)
    && !/\bnot\b|n't\b|\b(?:pending|waiting|will|once|when|after|until|should|expected|queued|started|in progress)\b/i.test(sentence));
}
/** The run read a product record naming `id` at or after `since`. Call-API payloads are redacted
 * in run evidence, so only tool outputs that expose the record count as proof of the read. */
function readRecordAfter(o: InvocationObservation, runId: string | undefined, id: string | undefined, since?: string | null) {
  return !!runId && !!id && (o.toolReads ?? []).some(row => row.runId === runId && row.output.includes(id)
    && (!since || Date.parse(row.at) >= Date.parse(since)));
}
export function gradeIntegratorRoutineInvocation(value: unknown) {
  const c = checks(); const o = invocationObservation(value);
  c.add("actual-invocation-and-output", !!o && Array.isArray(o.toolReads), "Requires public invocation, task, native output, tool-read and original response evidence.");
  if (!o) return c.result();
  const invocation = o.invocations[0]; const task = o.tasks.find(row => row.id === invocation?.linkedIssueId);
  const first = invocationObservation(o.state.firstInvocation);
  const firstInvocation = first?.invocations[0];
  const projectId = (o.state.project as Entity | undefined)?.id;
  c.add("one-manual-launch-input", o.invocations.length === 1 && invocation?.source === "manual" && invocation.routineId === o.routine.id
    && invocation.triggerPayload?.variables != null && (invocation.triggerPayload.variables as Record<string, unknown>).projectName === "Launch"
    && !!task && task.projectId === projectId && task.assigneeAgentId === o.leadId,
  "Exactly one manual invocation retains the supplied project-name input and creates the intended owned Launch task.");
  c.add("same-delivery-is-not-new-intent", !!firstInvocation?.idempotencyKey && o.state.replayRunId === invocation?.id
    && o.state.replayIssueId === task?.id && firstInvocation.id === invocation?.id && o.invocations.length === 1,
  "Replaying the committed public invocation with its original key retains the same invocation and task IDs.");
  c.add("accepted-versus-completed-at-first-reply", !!first && first.invocations.length === 1 && first.reply.trim().length > 0
    && (!prematureCompletionClaim(first.reply) || firstInvocation?.status === "completed" && first.tasks.some(row => row.id === firstInvocation.linkedIssueId && row.status === "done")),
  "The first answer cannot claim a completed summary before the saved invocation and task actually complete.");
  const outputRun = o.runs.find(run => run.contextSnapshot?.issueId === task?.id && run.agentId === o.leadId && run.status === "succeeded" && run.runtimeMode === "native");
  const output = o.outputComments.filter(row => row.authorAgentId === o.leadId && row.createdByRunId === outputRun?.id && (row.body ?? "").trim().length > 0);
  c.add("actual-completed-summary", !!task && invocation?.status === "completed" && task.status === "done" && !!outputRun && output.length > 0
    && readRecordAfter(o, outputRun?.id, projectId),
  "The routine's own native task run read the actual Launch project, saved its summary on the task and completed normally.");
  // The follow-up answer comes from a chat run that did not exist at the first reply and is not the routine's own task run.
  const followUp = o.runs.find(run => run.agentId === o.leadId && run.status === "succeeded" && run.contextSnapshot?.issueId !== task?.id
    && !!first && !first.runs.some(row => row.id === run.id));
  const later = first && o.reply.startsWith(first.reply) ? o.reply.slice(first.reply.length).trim() : "";
  c.add("later-actual-result-and-task-link", !!task && hasLink(o, "issues", task) && later.length > 0 && !!followUp
    && readRecordAfter(o, followUp?.id, task.id, invocation?.completedAt ? new Date(invocation.completedAt).toISOString() : undefined),
  "The explicit later request is answered by a new chat run that read the completed result task after the invocation finished, and the conversation links that task.");
  return c.result();
}
/** Validate prerequisite input against the same supported public creation schema. */
export function launchSummaryRoutineInput(projectId: string, assigneeAgentId: string) {
  return createRoutineSchema.parse({ title: "Launch summary", projectId, assigneeAgentId,
    description: "Summarize the actual {{projectName}} project in one saved task comment, including its actual payment approval state. Link the project and mark this summary task done. Do not change project records or create follow-up tasks.",
    variables: [{ name: "projectName", type: "text", required: true }] });
}
export const integratorRoutineInvocationCases = [integratorDefinition("routines", "routines.run-now", async ctx => {
  const p = await project(ctx, "Launch", { description: "Synthetic Launch project. Payment approval is pending; no approval has been received." });
  const routine = await ctx.input.api.post<RoutineDetail>(`/api/companies/${ctx.input.fixtures.company.id}/routines`, launchSummaryRoutineInput(p.id, ctx.input.fixtures.agent.id));
  return { project: p, routine };
}, (ctx, state) => observeInvocation(ctx, state, true), gradeIntegratorRoutineInvocation, async (ctx, _state, value) => {
  const o = invocationObservation(value); const task = o?.tasks.find(row => row.id === o.invocations[0]?.linkedIssueId);
  if (!o || !task) throw new Error("Missing actual routine result task");
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, task.title!, resultHref(o, task.identifier ?? task.id, "issues") ?? resultHref(o, task.id, "issues"));
}, {
  oracleVersion: "paperclip.chat-catalog.integrator.routine-invocation.v2",
  sourceFiles: ["chat-catalog-domains/integrator-routine-invocation.ts", "run-observations.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/routines.yaml"],
  expectedRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    const first = await pollUntil({ label: "routine invocation first actual reply", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000), intervalMs: 1000,
      load: () => observeInvocation(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.invocations.length === 1 && o.runs.some(row => row.agentId === o.leadId && row.contextSnapshot?.issueId === ctx.issue()?.id && row.status === "succeeded") && ctx.issue()?.conversationState === "waiting"),
      reject: o => o.invocations.length > 1 ? "Initial request created duplicate routine invocations" : undefined });
    state.firstInvocation = { ...first, state: structuredClone(state) };
    const invocation = first.invocations[0]!;
    if (!invocation.idempotencyKey || !invocation.linkedIssueId) throw new Error("Committed routine invocation has no replayable public identity");
    // Independent transport-delivery probe of the existing committed request;
    // it must not supply another user intent or admit another execution.
    const replay = await ctx.input.api.post<RoutineRunSummary>(`/api/routines/${invocation.routineId}/run`, {
      source: invocation.source, triggerId: invocation.triggerId, idempotencyKey: invocation.idempotencyKey,
      payload: invocation.triggerPayload, variables: invocation.triggerPayload?.variables,
    });
    state.replayRunId = replay.id; state.replayIssueId = replay.linkedIssueId;
    await ctx.input.evidence("chat-routine-invocation-first-response.json", state.firstInvocation);
    await pollUntil({ label: "real routine execution completed", deadlineAt: Date.now() + 240_000, intervalMs: 1000,
      load: () => observeInvocation(ctx, state), accept: o => o.invocations.length === 1 && o.invocations[0]?.status === "completed" && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded"),
      reject: o => o.invocations.length > 1 || o.runs.length > 2 ? "Delivery replay admitted unexpected additional work" : undefined });
    const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, "What was the actual result of that summary run?", chatCatalogNativePhaseRemainingBudget(ctx));
  },
})];
